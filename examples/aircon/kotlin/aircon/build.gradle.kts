plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    application
}

description = "The air conditioner of catalog/aircon.acidcat.json, written with acid-cat-core-kotlin."

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // The Android app runs this code too, so it targets the bytecode of Java 17.
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

java {
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    api("dev.acidcat:acid-cat-core-kotlin")
    testImplementation(libs.kotlin.test)
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
}

// `gradle :aircon-kotlin:run --args="aircon power set --on"` runs the command line.
application {
    mainClass.set("dev.acidcat.example.aircon.CliKt")
}

/** The MCP server through stdio, for an MCP client that starts it as a process. */
tasks.register<JavaExec>("mcp") {
    description = "Run the MCP server of the air conditioner through stdio."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("dev.acidcat.example.aircon.McpKt")
    standardInput = System.`in`
}

tasks.test {
    useJUnitPlatform()
    systemProperty("aircon.catalog", rootDir.resolve("../catalog/aircon.acidcat.json").canonicalPath)
    inputs.file(rootDir.resolve("../catalog/aircon.acidcat.json"))
}
