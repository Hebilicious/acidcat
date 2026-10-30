plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    id("dev.acidcat.appfunctions")
}

android {
    namespace = "dev.acidcat.example.aircon.android"
    compileSdk = 37
    defaultConfig {
        applicationId = "dev.acidcat.example.aircon"
        minSdk = 36
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

// The app functions come from the shared catalog of the air conditioner, at build time: the target phone of
// catalog/aircon.acidcat.json. The test of :aircon-kotlin checks that the Kotlin code agrees with that catalog.
acidCatAppFunctions {
    catalog.set(file("../../catalog/aircon.acidcat.json"))
    target.set("phone")
    packageName.set("dev.acidcat.example.aircon.android.functions")
    serviceName.set("AirconAppFunctionService")
    provider.set("dev.acidcat.example.aircon.android.Aircon")
}

dependencies {
    implementation(project(":aircon-kotlin"))
    implementation("dev.acidcat:acid-cat-appfunctions")
    ksp(libs.appfunctions.compiler)
}
