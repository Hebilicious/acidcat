rootProject.name = "aircon-kotlin"

pluginManagement {
    // The Gradle plugin that generates the app functions comes from its own build in this repository.
    includeBuild("../../../packages/appfunctions/gradle-plugin")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
    versionCatalogs {
        create("libs") { from(files("../../../packages/core-kotlin/gradle/libs.versions.toml")) }
    }
}

// The Kotlin core and the AppFunctions runtime come from their builds in this repository.
includeBuild("../../../packages/core-kotlin")
includeBuild("../../../packages/appfunctions")

include(":aircon", ":android")
project(":aircon").name = "aircon-kotlin"
project(":android").name = "aircon-android"
