plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `java-library`
    `maven-publish`
}

description = "Serve AcidCat capabilities in Kotlin, with coroutines and kotlinx.serialization."

kotlin {
    jvmToolchain(21)
    explicitApi()
    compilerOptions {
        // Android runs bytecode for Java 17, so the core targets it.
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

java {
    targetCompatibility = JavaVersion.VERSION_17
    withSourcesJar()
}

dependencies {
    api(libs.coroutines.core)
    api(libs.serialization.json)
    implementation(libs.json.schema.validator)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.coroutines.test)
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
}

// The JAR has the license file of the repository.
tasks.jar {
    from(rootProject.file("LICENSE")) { into("META-INF") }
}

tasks.test {
    useJUnitPlatform()
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
                name.set("acid-cat-core-kotlin")
                description.set(project.description)
                url.set("https://github.com/Hebilicious/acidcat/tree/main/packages/core-kotlin")
                licenses { license { name.set("MIT"); url.set("https://github.com/Hebilicious/acidcat/blob/main/LICENSE") } }
                developers { developer { id.set("Hebilicious"); url.set("https://github.com/Hebilicious") } }
                scm { url.set("https://github.com/Hebilicious/acidcat"); connection.set("scm:git:https://github.com/Hebilicious/acidcat.git") }
            }
        }
    }
}
