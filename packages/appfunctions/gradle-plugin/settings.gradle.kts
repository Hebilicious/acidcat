rootProject.name = "acid-cat-appfunctions-gradle-plugin"

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    versionCatalogs {
        create("libs") { from(files("../../core-kotlin/gradle/libs.versions.toml")) }
    }
}

// The generator reads catalogs with the functions of the Kotlin core.
includeBuild("../../core-kotlin")
