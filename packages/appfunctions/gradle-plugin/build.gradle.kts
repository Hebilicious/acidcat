plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-gradle-plugin`
    `maven-publish`
}

group = "dev.acidcat"
version = "0.1.0"
description = "Generate the AppFunctions service of an Android app from the view of a target of its AcidCat catalog."

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
    implementation("dev.acidcat:acid-cat-core-kotlin")
    compileOnly(libs.android.gradle.plugin.api)
    testImplementation(libs.kotlin.test)
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
}

gradlePlugin {
    plugins {
        create("appfunctions") {
            id = "dev.acidcat.appfunctions"
            implementationClass = "dev.acidcat.appfunctions.gradle.AppFunctionsPlugin"
            displayName = "AcidCat AppFunctions"
            description = project.description
        }
    }
}

publishing {
    repositories {
        // `moon run <project>:package` publishes here, as Maven Central receives the files.
        maven {
            name = "local"
            url = uri(rootProject.layout.buildDirectory.dir("repository"))
        }
    }
}

// The JAR has the license file of the repository.
tasks.jar {
    from(rootProject.file("LICENSE")) { into("META-INF") }
}

tasks.test {
    useJUnitPlatform()
    systemProperty("acidcat.fixture", rootDir.resolve("../../core-kotlin/fixture/fixture.acidcat.json").canonicalPath)
    systemProperty("acidcat.shapes", rootDir.resolve("../shapes/shapes.acidcat.json").canonicalPath)
    systemProperty("acidcat.expected", rootDir.resolve("src/test/resources/expected").canonicalPath)
    // `gradle test -Dacidcat.update=true` writes the expected files again.
    systemProperty("acidcat.update", System.getProperty("acidcat.update") ?: "false")
    inputs.dir(rootDir.resolve("src/test/resources"))
    inputs.file(rootDir.resolve("../shapes/shapes.acidcat.json"))
    inputs.file(rootDir.resolve("../../core-kotlin/fixture/fixture.acidcat.json"))
}
