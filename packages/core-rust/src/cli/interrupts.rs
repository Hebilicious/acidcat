use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};

pub(super) enum Interrupts {
    /// Tokio and signal-hook remove no handler, so through them the default action never comes back.
    OwnHandler {
        replaced: libc::sigaction,
        _writer: UnixStream,
    },
    /// signal-hook keeps the handler that the signal had, and calls it before the action of the core.
    ActionNextToHandler(signal_hook_registry::SigId),
}

static HANDLER_WRITES_TO: AtomicI32 = AtomicI32::new(-1);
static HANDLERS_RUNNING: AtomicUsize = AtomicUsize::new(0);

extern "C" fn on_interrupt(_signal: libc::c_int) {
    HANDLERS_RUNNING.fetch_add(1, Ordering::SeqCst);
    let errno = errno::errno();
    let writer = HANDLER_WRITES_TO.load(Ordering::SeqCst);
    if writer >= 0 {
        // SAFETY: `write` is async-signal-safe, and the drop of `Interrupts` closes the writer when no handler runs.
        unsafe { libc::write(writer, [0_u8].as_ptr().cast(), 1) };
    }
    errno::set_errno(errno);
    HANDLERS_RUNNING.fetch_sub(1, Ordering::SeqCst);
}

fn our_handler() -> libc::sighandler_t {
    on_interrupt as extern "C" fn(libc::c_int) as libc::sighandler_t
}

fn has_no_handler(action: &libc::sigaction) -> bool {
    action.sa_sigaction == libc::SIG_DFL || action.sa_sigaction == libc::SIG_IGN
}

fn disposition(new: Option<&libc::sigaction>) -> std::io::Result<libc::sigaction> {
    // SAFETY: `sigaction` is plain data, and all zeros is a valid value of it.
    let mut old = unsafe { std::mem::zeroed() };
    let new = new.map_or(std::ptr::null(), std::ptr::from_ref);
    // SAFETY: `new` is null or points to a valid `sigaction`, and `old` is valid for writes.
    if unsafe { libc::sigaction(libc::SIGINT, new, &mut old) } == 0 {
        Ok(old)
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn restore_unless_ours_was_replaced(replaced: &libc::sigaction) {
    if let Ok(removed) = disposition(Some(replaced))
        && removed.sa_sigaction != our_handler()
    {
        let _ = disposition(Some(&removed));
    }
}

impl Interrupts {
    pub(super) fn start(writer: UnixStream) -> std::io::Result<Self> {
        writer.set_nonblocking(true)?;
        if has_no_handler(&disposition(None)?)
            && HANDLER_WRITES_TO
                .compare_exchange(-1, writer.as_raw_fd(), Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            // SAFETY: as in `disposition`.
            let mut ours: libc::sigaction = unsafe { std::mem::zeroed() };
            ours.sa_sigaction = our_handler();
            ours.sa_flags = libc::SA_RESTART;
            // SAFETY: `sa_mask` is valid for writes.
            unsafe { libc::sigemptyset(&mut ours.sa_mask) };
            match disposition(Some(&ours)) {
                Ok(replaced) if has_no_handler(&replaced) => {
                    return Ok(Interrupts::OwnHandler {
                        replaced,
                        _writer: writer,
                    });
                }
                Ok(set_meanwhile) => {
                    let _ = disposition(Some(&set_meanwhile));
                }
                Err(_) => {}
            }
            HANDLER_WRITES_TO.store(-1, Ordering::SeqCst);
        }
        // SAFETY: the action only writes to a socket that does not block, which is async-signal-safe.
        let id = unsafe {
            signal_hook_registry::register(libc::SIGINT, move || {
                let _ = (&writer).write(&[0]);
            })
        }?;
        Ok(Interrupts::ActionNextToHandler(id))
    }
}

impl Drop for Interrupts {
    fn drop(&mut self) {
        match self {
            Interrupts::OwnHandler { replaced, .. } => {
                restore_unless_ours_was_replaced(replaced);
                HANDLER_WRITES_TO.store(-1, Ordering::SeqCst);
                while HANDLERS_RUNNING.load(Ordering::SeqCst) > 0 {
                    std::hint::spin_loop();
                }
            }
            Interrupts::ActionNextToHandler(id) => {
                signal_hook_registry::unregister(*id);
            }
        }
    }
}
