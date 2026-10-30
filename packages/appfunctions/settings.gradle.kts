rootProject.name = "appfunctions"

pluginManagement {
    includeBuild("gradle-plugin")
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
        create("libs") { from(files("../core-kotlin/gradle/libs.versions.toml")) }
    }
}

// The runtime and the fixture use the Kotlin core and its fixture from their own build.
includeBuild("../core-kotlin")

include(":runtime", ":fixture", ":shapes")

project(":runtime").name = "acid-cat-appfunctions"
// The Kotlin core has a project named fixture too. A different name keeps the two apart.
project(":fixture").name = "appfunctions-fixture"
project(":shapes").name = "appfunctions-shapes"
