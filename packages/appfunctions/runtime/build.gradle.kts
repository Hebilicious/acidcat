plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
    `maven-publish`
}

description = "Serve the capabilities of an AcidCat target as Android AppFunctions."

android {
    namespace = "dev.acidcat.appfunctions"
    compileSdk = 37
    defaultConfig {
        minSdk = 36
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        // Robolectric gives the tests the classes of Android, for example the exceptions of AppFunctions.
        unitTests.isIncludeAndroidResources = true
    }
    publishing {
        singleVariant("release") { withSourcesJar() }
    }
}

kotlin {
    explicitApi()
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    api("dev.acidcat:acid-cat-core-kotlin")
    api(libs.appfunctions)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.coroutines.test)
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit4)
    testImplementation(libs.robolectric)
    testRuntimeOnly(libs.junit.vintage)
    testRuntimeOnly(libs.junit.launcher)
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    // Robolectric runs the Android SDK 36 only on Java 21 or later.
    javaLauncher.set(javaToolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(21)) })
    // Robolectric reads an internal class of the JDK.
    jvmArgs("--add-exports", "java.base/jdk.internal.access=ALL-UNNAMED", "--add-opens", "java.base/jdk.internal.access=ALL-UNNAMED")
}

publishing {
    repositories {
        // `moon run <project>:package` publishes here, as Maven Central receives the files.
        maven {
            name = "local"
            url = uri(rootProject.layout.buildDirectory.dir("repository"))
        }
    }
    publications {
        create<MavenPublication>("release") {
            artifactId = "acid-cat-appfunctions"
            afterEvaluate { from(components["release"]) }
            pom {
                name.set("acid-cat-appfunctions")
                description.set(project.description)
                url.set("https://github.com/Hebilicious/acidcat/tree/main/packages/appfunctions")
                licenses { license { name.set("MIT"); url.set("https://github.com/Hebilicious/acidcat/blob/main/LICENSE") } }
                developers { developer { id.set("Hebilicious"); url.set("https://github.com/Hebilicious") } }
                scm { url.set("https://github.com/Hebilicious/acidcat"); connection.set("scm:git:https://github.com/Hebilicious/acidcat.git") }
            }
        }
    }
}
