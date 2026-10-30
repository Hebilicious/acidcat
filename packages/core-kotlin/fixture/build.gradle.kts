plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `java-library`
}

description = "The conformance fixture, written with acid-cat-core-kotlin, and the test that runs acid-cat conform against it."

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

java {
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    api(project(":acid-cat-core-kotlin"))
    testImplementation(project(":acid-cat-ktor"))
    testImplementation(libs.ktor.server.netty)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.coroutines.test)
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
}

tasks.test {
    useJUnitPlatform()
    // The conformance test runs `acid-cat conform` from packages/cli with Node.
    systemProperty("acidcat.repository", rootDir.resolve("../..").canonicalPath)
    systemProperty("acidcat.report", layout.buildDirectory.file("conform.txt").get().asFile.path)
    inputs.dir(rootDir.resolve("../cli/src"))
    inputs.file(rootDir.resolve("../cli/conformance/fixture.acidcat.json"))
    testLogging {
        events("failed")
        showStandardStreams = false
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

/** Write fixture.acidcat.json, the catalog that the core writes for the fixture. The AppFunctions fixture reads it. */
tasks.register<JavaExec>("writeCatalog") {
    description = "Write the catalog of the fixture to fixture.acidcat.json."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("dev.acidcat.fixture.WriteCatalog")
    args(layout.projectDirectory.file("fixture.acidcat.json").asFile.path)
}
