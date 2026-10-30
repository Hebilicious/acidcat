# acid-cat-appfunctions

Serve the capabilities of an AcidCat target as Android app functions, with the [AppFunctions binding](../../spec/bindings/appfunctions.md). Agents and assistants on the device, for example Gemini, find the app functions and call them. Maven packages: `dev.acidcat:acid-cat-appfunctions`, and the Gradle plugin `dev.acidcat.appfunctions`.

AppFunctions needs Android 16 (API 36) or later, and the Jetpack library `androidx.appfunctions`, which is in beta. The capabilities use [`acid-cat-core-kotlin`](../core-kotlin).

## How it works

1. The application writes its catalog from its code, with `acid-cat-core-kotlin`, and commits it.
2. At build time, the Gradle plugin reads the view of one target of the catalog. It generates an abstract `AppFunctionService` with one `@AppFunctionDeclaration` for each capability, an `@AppFunctionSerializable` class for each object type, the manifest of the service, and the app metadata.
3. The AppFunctions compiler (KSP) reads the generated code. It writes the concrete service and the XML file that the platform indexes.
4. At run time, each generated function calls `AppFunctionsBinding.call`. The call has its own session. The binding gives the value as the return value, and each call failure as the `AppFunctionException` of its kind.
5. `keepAvailability` keeps the enabled state of each app function equal to the availability of its capability.

The app does not read the catalog at run time.

## Use it

```kotlin
// build.gradle.kts of the app
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
    id("dev.acidcat.appfunctions")
}

acidCatAppFunctions {
    catalog.set(file("acidcat.catalog.json"))
    target.set("android")
    packageName.set("com.example.notes.functions")
    serviceName.set("NotesAppFunctionService")
    provider.set("com.example.notes.NotesFunctions")
}

dependencies {
    implementation("dev.acidcat:acid-cat-appfunctions:0.1.0")
    ksp("androidx.appfunctions:appfunctions-compiler:1.0.0-beta01")
}
```

The provider is an `object` that gives the binding. All the services and all the calls of the process share it:

```kotlin
object NotesFunctions : AppFunctionsProvider {
    private val binding by lazy { AppFunctionsBinding(notesApp, target = "android", context = NotesContext()) }
    override fun binding(context: Context): AppFunctionsBinding<*> = binding
}

class NotesApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        NotesAppFunctionServiceFunctions.keepAvailability(this, MainScope())
    }
}
```

The plugin adds the service to the manifest of the app. The app declares only its `Application`. The description of the catalog becomes the `instructions` of the app metadata, for the agents.

### Generated code

For the capability `notes.note.create`, with an input that has the properties `title` and `body`, and an output `Note`, the plugin writes:

```kotlin
/**
 * Create a note.
 *
 * @param title The title of the note.
 */
@AppFunctionDeclaration(isDescribedByKDoc = true)
public suspend fun notes_note_create(
    body: String? = null,
    title: String,
): Note =
    binding.call(
        id = "notes.note.create",
        input = input {
            put("body", body)
            put("title", title)
        },
        value = { decode(Note.serializer(), it) },
    )
```

[`gradle-plugin/src/test/resources/expected`](gradle-plugin/src/test/resources/expected) has the generated files of the fixture and of the shapes. The [binding](../../spec/bindings/appfunctions.md#types) tells how each schema becomes a type, and how a failure becomes a result.

## Tests

| Task | Test |
| --- | --- |
| `moon run appfunctions:test` | The generator, against the expected files. The runtime, with Robolectric. The build of the fixture app and of the shapes, so that the AppFunctions compiler reads the generated code |
| `moon run appfunctions:conform` | Install the fixture app on a device or an emulator with Android 16 or later, and run `acid-cat conform --appfunctions dev.acidcat.fixture` against it. `ANDROID_SERIAL` chooses the device |
| `moon run appfunctions:package` | Write the files that Maven Central and the Gradle Plugin Portal receive into `build/repository` |

- [`fixture/`](fixture) is an Android app that serves the target `android` of the fixture of [`acid-cat-core-kotlin`](../core-kotlin), as app functions.
- [`shapes/`](shapes) is an Android library whose catalog, [`shapes.acidcat.json`](shapes/shapes.acidcat.json), has one capability for each kind of schema. The build compiles its generated code. Nothing runs it.

## Limits

- The Jetpack library of AppFunctions is in beta, and its API can change.
- On the device, only callers with the permission `EXECUTE_APP_FUNCTIONS` can execute app functions, for example system agents and `adb shell`.
- The code that the AppFunctions compiler writes does not put Kotlin keywords in backticks. Thus a property named `in` or `class` gets `_` after its name (`in_`).
