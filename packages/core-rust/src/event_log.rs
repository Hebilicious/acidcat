//! The event log: one event that the application publishes once, and that each subscription receives. A store keeps
//! the occurrences, so that a client resumes with a cursor (spec/events.md#resuming), also after a restart when the
//! store keeps them on disk.

use std::collections::VecDeque;
use std::marker::PhantomData;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::Stream;
use futures::future::BoxFuture;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::app::{Emitted, Subscription};
use crate::outcome::Defect;

/// The number of records that a subscription reads from the store at one time when it resumes.
const PAGE: usize = 256;

/// The number of records that a subscription keeps before it reads from the store again.
const LIVE_BUFFER: usize = 1024;

/// One occurrence in a store.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    /// The position of the occurrence in the log: 1 for the first occurrence, then one more for each occurrence.
    pub position: u64,
    pub event_id: String,
    /// When the application published the occurrence, in milliseconds since the Unix epoch.
    pub timestamp_ms: u64,
    pub data: Value,
}

/// Where an event log keeps its records. Implement it to keep the records in a database or a file, so that a client
/// resumes after the application restarts.
pub trait EventStore: Send + Sync + 'static {
    /// The id of the records of this store. A cursor of a different epoch makes the subscription start at the first
    /// record of the store. Keep it the same across restarts when the store keeps its records.
    fn epoch(&self) -> String;

    /// Keep a record. The positions of the records come one after the other.
    fn append(&self, record: Record) -> BoxFuture<'_, Result<(), Defect>>;

    /// At most `limit` records with a position after `position`, in the order of their positions. A store can remove
    /// old records: the first record then has a position after `position + 1`.
    fn after(&self, position: u64, limit: usize) -> BoxFuture<'_, Result<Vec<Record>, Defect>>;

    /// The position of the last record, or 0 when the store has none.
    fn last_position(&self) -> BoxFuture<'_, Result<u64, Defect>>;
}

/// A store in memory. It keeps the last `capacity` records. Its records end with the process, so it has a new epoch
/// each time that it starts.
pub struct MemoryStore {
    epoch: String,
    capacity: usize,
    records: Mutex<VecDeque<Record>>,
}

impl MemoryStore {
    pub fn new(capacity: usize) -> Self {
        MemoryStore {
            epoch: uuid::Uuid::new_v4().simple().to_string(),
            capacity: capacity.max(1),
            records: Mutex::new(VecDeque::new()),
        }
    }

    fn records(&self) -> MutexGuard<'_, VecDeque<Record>> {
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl EventStore for MemoryStore {
    fn epoch(&self) -> String {
        self.epoch.clone()
    }

    fn append(&self, record: Record) -> BoxFuture<'_, Result<(), Defect>> {
        let mut records = self.records();
        records.push_back(record);
        while records.len() > self.capacity {
            records.pop_front();
        }
        Box::pin(async { Ok(()) })
    }

    fn after(&self, position: u64, limit: usize) -> BoxFuture<'_, Result<Vec<Record>, Defect>> {
        let found = self
            .records()
            .iter()
            .filter(|record| record.position > position)
            .take(limit)
            .cloned()
            .collect();
        Box::pin(async { Ok(found) })
    }

    fn last_position(&self) -> BoxFuture<'_, Result<u64, Defect>> {
        let last = self.records().back().map_or(0, |record| record.position);
        Box::pin(async move { Ok(last) })
    }
}

struct Head {
    /// The position of the last occurrence that the log published.
    last: u64,
    sender: broadcast::Sender<Record>,
}

struct Inner {
    store: Box<dyn EventStore>,
    epoch: String,
    /// Publishers take turns, so that the positions in the store come one after the other.
    publishing: tokio::sync::Mutex<()>,
    head: Mutex<Head>,
}

impl Inner {
    fn head(&self) -> MutexGuard<'_, Head> {
        self.head
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// An event that the application publishes once, and that each subscription receives. Clones share the log.
///
/// Each occurrence has a cursor. A client that gives the cursor of its last occurrence gets the occurrences after it
/// from the store, then the new occurrences. If the store removed some of them, or `maxAgeMs` skips some of them, the
/// first occurrence has `truncated: true`.
pub struct EventLog<P> {
    inner: Arc<Inner>,
    payload: PhantomData<fn(P) -> P>,
}

impl<P> Clone for EventLog<P> {
    fn clone(&self) -> Self {
        EventLog {
            inner: self.inner.clone(),
            payload: PhantomData,
        }
    }
}

impl<P: Serialize + DeserializeOwned + Send + 'static> EventLog<P> {
    /// A log that keeps the last `capacity` occurrences in memory.
    pub fn in_memory(capacity: usize) -> Self {
        Self::with_last_position(Box::new(MemoryStore::new(capacity)), 0)
    }

    /// A log on a store. The positions continue after the last record of the store.
    pub async fn open(store: impl EventStore) -> Result<Self, Defect> {
        let last = store.last_position().await?;
        Ok(Self::with_last_position(Box::new(store), last))
    }

    fn with_last_position(store: Box<dyn EventStore>, last: u64) -> Self {
        let (sender, _) = broadcast::channel(LIVE_BUFFER);
        EventLog {
            inner: Arc::new(Inner {
                epoch: store.epoch(),
                store,
                publishing: tokio::sync::Mutex::new(()),
                head: Mutex::new(Head { last, sender }),
            }),
            payload: PhantomData,
        }
    }

    /// The number of subscriptions that follow the log now.
    pub fn subscriptions(&self) -> usize {
        self.inner.head().sender.receiver_count()
    }

    /// Publish one occurrence to each subscription. The result is its cursor.
    pub async fn publish(&self, data: P) -> Result<String, Defect> {
        let data = serde_json::to_value(data)?;
        let _turn = self.inner.publishing.lock().await;
        let position = self.inner.head().last + 1;
        let record = Record {
            position,
            event_id: uuid::Uuid::new_v4().to_string(),
            timestamp_ms: now_ms(),
            data,
        };
        self.inner.store.append(record.clone()).await?;
        let mut head = self.inner.head();
        head.last = position;
        // A send fails only when no subscription listens.
        let _ = head.sender.send(record);
        Ok(make_cursor(&self.inner.epoch, position))
    }

    /// The occurrences for one subscription, from its cursor and its `maxAgeMs`. Give it as the provider of the event:
    /// `.subscribe(move |(), subscription| log.subscribe(&subscription))`.
    pub fn subscribe<C>(
        &self,
        subscription: &Subscription<C>,
    ) -> impl Stream<Item = Result<Emitted<P>, Defect>> + Send + 'static + use<P, C> {
        self.follow(subscription.cursor(), subscription.max_age_ms())
    }

    /// The occurrences after a cursor. With no cursor, the stream starts now. `max_age_ms` skips the occurrences of
    /// the store that are older than this number of milliseconds.
    pub fn follow(
        &self,
        cursor: Option<&str>,
        max_age_ms: Option<u64>,
    ) -> impl Stream<Item = Result<Emitted<P>, Defect>> + Send + 'static + use<P> {
        let (receiver, head) = {
            let head = self.inner.head();
            (head.sender.subscribe(), head.last)
        };
        // Where the replay from the store starts, and if the start skips occurrences.
        let start = match cursor.map(|text| parse_cursor(text, &self.inner.epoch)) {
            None => Start::At(head),
            Some(Some(position)) => Start::At(position.min(head)),
            Some(None) => Start::Truncated,
        };
        let (last, truncated) = match start {
            Start::At(position) => (position, false),
            Start::Truncated => (0, true),
        };
        let follower = Follower {
            log: self.inner.clone(),
            receiver,
            pending: VecDeque::new(),
            last,
            replay_until: head,
            truncated,
            oldest_ms: max_age_ms.map(|age| now_ms().saturating_sub(age)),
        };
        futures::stream::unfold(follower, |mut follower| async move {
            let next = follower.next().await?;
            let emitted = next.and_then(|record| {
                let timestamp = UNIX_EPOCH + Duration::from_millis(record.timestamp_ms);
                let mut emitted = Emitted::new(serde_json::from_value::<P>(record.data)?)
                    .event_id(record.event_id)
                    .timestamp(humantime::format_rfc3339_millis(timestamp).to_string())
                    .cursor(make_cursor(&follower.log.epoch, record.position));
                if std::mem::take(&mut follower.truncated) {
                    emitted = emitted.truncated();
                }
                Ok(emitted)
            });
            Some((emitted, follower))
        })
    }
}

enum Start {
    At(u64),
    /// The cursor is not a cursor of this log: start at the first record of the store.
    Truncated,
}

/// The state of one subscription to a log.
struct Follower {
    log: Arc<Inner>,
    receiver: broadcast::Receiver<Record>,
    /// The records of the store to send before the new records.
    pending: VecDeque<Record>,
    /// The position of the last record that the subscription sent, or where it starts.
    last: u64,
    /// The store has the records up to this position, which the subscription sends before the new ones.
    replay_until: u64,
    /// The next record has `truncated: true`.
    truncated: bool,
    /// Skip the records of the store that are older than this time.
    oldest_ms: Option<u64>,
}

impl Follower {
    /// The next record. `None` never comes: the log has no end.
    async fn next(&mut self) -> Option<Result<Record, Defect>> {
        loop {
            if let Some(record) = self.pending.pop_front() {
                self.last = record.position;
                return Some(Ok(record));
            }
            if self.last < self.replay_until {
                if let Err(defect) = self.read_store().await {
                    return Some(Err(defect));
                }
                continue;
            }
            match self.receiver.recv().await {
                Ok(record) if record.position <= self.last => {}
                Ok(record) if record.position == self.last + 1 => {
                    self.last = record.position;
                    return Some(Ok(record));
                }
                // A record is missing: read it from the store.
                Ok(record) => self.replay_until = record.position,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    self.replay_until = self.log.head().last;
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }

    /// Read the next page of the store into `pending`, up to `replay_until`.
    async fn read_store(&mut self) -> Result<(), Defect> {
        let records = self.log.store.after(self.last, PAGE).await?;
        let Some(first) = records.first() else {
            // The store has no more records: it removed them.
            self.truncated = true;
            self.last = self.replay_until;
            return Ok(());
        };
        if first.position > self.last + 1 {
            self.truncated = true;
        }
        let mut read_until = self.last;
        for record in records {
            if record.position > self.replay_until {
                break;
            }
            read_until = record.position;
            if self
                .oldest_ms
                .is_some_and(|oldest| record.timestamp_ms < oldest)
            {
                self.truncated = true;
                continue;
            }
            self.pending.push_back(record);
        }
        if self.pending.is_empty() {
            // Each record of the page was too old, or after the end of the replay.
            self.last = if read_until == self.last {
                self.replay_until
            } else {
                read_until
            };
        }
        Ok(())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

fn make_cursor(epoch: &str, position: u64) -> String {
    format!("{epoch}.{position}")
}

/// The position of a cursor of this epoch.
fn parse_cursor(text: &str, epoch: &str) -> Option<u64> {
    let (from, position) = text.rsplit_once('.')?;
    (from == epoch).then(|| position.parse().ok()).flatten()
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;
    use serde::Deserialize;

    use super::*;

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    struct Imported {
        title: String,
    }

    fn imported(title: &str) -> Imported {
        Imported {
            title: title.into(),
        }
    }

    async fn take(
        stream: impl Stream<Item = Result<Emitted<Imported>, Defect>>,
        count: usize,
    ) -> Vec<Emitted<Imported>> {
        let items: Vec<_> = tokio::time::timeout(
            Duration::from_secs(5),
            stream.take(count).collect::<Vec<_>>(),
        )
        .await
        .expect("the occurrences come");
        items
            .into_iter()
            .map(|item| item.expect("an occurrence"))
            .collect()
    }

    #[tokio::test]
    async fn each_subscription_receives_each_occurrence() {
        let log = EventLog::in_memory(10);
        let first = log.follow(None, None);
        let second = log.follow(None, None);
        log.publish(imported("a")).await.unwrap();
        log.publish(imported("b")).await.unwrap();
        for stream in [first.boxed(), second.boxed()] {
            let titles: Vec<String> = take(stream, 2)
                .await
                .into_iter()
                .map(|emitted| emitted.data.title)
                .collect();
            assert_eq!(titles, ["a", "b"]);
        }
    }

    #[tokio::test]
    async fn a_subscription_without_a_cursor_starts_now() {
        let log = EventLog::in_memory(10);
        log.publish(imported("old")).await.unwrap();
        let stream = log.follow(None, None);
        log.publish(imported("new")).await.unwrap();
        let items = take(stream, 1).await;
        assert_eq!(items[0].data, imported("new"));
        assert!(!items[0].truncated);
    }

    #[tokio::test]
    async fn a_cursor_resumes_after_its_position() {
        let log = EventLog::in_memory(10);
        let cursor = log.publish(imported("a")).await.unwrap();
        log.publish(imported("b")).await.unwrap();
        log.publish(imported("c")).await.unwrap();
        let stream = log.follow(Some(&cursor), None);
        log.publish(imported("d")).await.unwrap();
        let items = take(stream, 3).await;
        let titles: Vec<&str> = items.iter().map(|item| item.data.title.as_str()).collect();
        assert_eq!(titles, ["b", "c", "d"]);
        assert!(items.iter().all(|item| !item.truncated));
        let positions: Vec<u64> = items
            .iter()
            .map(|item| parse_cursor(item.cursor.as_deref().unwrap(), &log.inner.epoch).unwrap())
            .collect();
        assert_eq!(positions, [2, 3, 4]);
    }

    #[tokio::test]
    async fn a_store_that_removed_occurrences_marks_the_first_as_truncated() {
        let log = EventLog::in_memory(2);
        let cursor = log.publish(imported("a")).await.unwrap();
        for title in ["b", "c", "d"] {
            log.publish(imported(title)).await.unwrap();
        }
        let items = take(log.follow(Some(&cursor), None), 2).await;
        assert_eq!(items[0].data, imported("c"));
        assert!(items[0].truncated);
        assert!(!items[1].truncated);
    }

    #[tokio::test]
    async fn a_cursor_of_another_epoch_starts_at_the_first_record() {
        let log = EventLog::in_memory(10);
        log.publish(imported("a")).await.unwrap();
        let items = take(log.follow(Some("other.7"), None), 1).await;
        assert_eq!(items[0].data, imported("a"));
        assert!(items[0].truncated);
    }

    #[tokio::test]
    async fn max_age_skips_old_occurrences() {
        let store = MemoryStore::new(10);
        store
            .append(Record {
                position: 1,
                event_id: "old".into(),
                timestamp_ms: 0,
                data: serde_json::to_value(imported("old")).unwrap(),
            })
            .await
            .unwrap();
        let log = EventLog::open(store).await.unwrap();
        let epoch = log.inner.epoch.clone();
        log.publish(imported("new")).await.unwrap();
        let items = take(log.follow(Some(&format!("{epoch}.0")), Some(60_000)), 1).await;
        assert_eq!(items[0].data, imported("new"));
        assert!(items[0].truncated);
    }

    #[tokio::test]
    async fn the_positions_continue_after_the_records_of_the_store() {
        let store = MemoryStore::new(10);
        store
            .append(Record {
                position: 41,
                event_id: "x".into(),
                timestamp_ms: now_ms(),
                data: serde_json::to_value(imported("x")).unwrap(),
            })
            .await
            .unwrap();
        let log = EventLog::<Imported>::open(store).await.unwrap();
        let cursor = log.publish(imported("y")).await.unwrap();
        assert!(cursor.ends_with(".42"));
    }

    #[tokio::test]
    async fn a_slow_subscription_reads_the_store() {
        let log = EventLog::in_memory(5000);
        let stream = log.follow(None, None);
        for index in 0..(LIVE_BUFFER + 100) {
            log.publish(imported(&index.to_string())).await.unwrap();
        }
        let items = take(stream, LIVE_BUFFER + 100).await;
        assert!(items.iter().all(|item| !item.truncated));
        assert_eq!(
            items.last().unwrap().data,
            imported(&(LIVE_BUFFER + 99).to_string())
        );
    }
}
