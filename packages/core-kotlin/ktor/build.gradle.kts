plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
    `maven-publish`
}

description = "Serve the MCP and HTTP bindings of acid-cat-core-kotlin with Ktor."

kotlin {
    jvmToolchain(21)
    explicitApi()
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

java {
    targetCompatibility = JavaVersion.VERSION_17
    withSourcesJar()
}

dependencies {
    api(project(":acid-cat-core-kotlin"))
    api(libs.ktor.server.core)
    compileOnly(libs.ktor.server.netty)
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
        create<MavenPublication>("maven") {
            from(components["java"])
            pom {
                name.set("acid-cat-ktor")
                description.set(project.description)
                url.set("https://github.com/Hebilicious/acidcat/tree/main/packages/core-kotlin")
                licenses { license { name.set("MIT"); url.set("https://github.com/Hebilicious/acidcat/blob/main/LICENSE") } }
                developers { developer { id.set("Hebilicious"); url.set("https://github.com/Hebilicious") } }
                scm { url.set("https://github.com/Hebilicious/acidcat"); connection.set("scm:git:https://github.com/Hebilicious/acidcat.git") }
            }
        }
    }
}

// The JAR has the license file of the repository.
tasks.jar {
    from(rootProject.file("LICENSE")) { into("META-INF") }
}
