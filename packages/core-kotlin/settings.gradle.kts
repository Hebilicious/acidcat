rootProject.name = "acid-cat-kotlin"

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

include(":core", ":ktor", ":fixture")

project(":core").name = "acid-cat-core-kotlin"
project(":ktor").name = "acid-cat-ktor"
