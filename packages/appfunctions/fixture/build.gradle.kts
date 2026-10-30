plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    id("dev.acidcat.appfunctions")
}

android {
    namespace = "dev.acidcat.fixture.android"
    compileSdk = 37
    defaultConfig {
        applicationId = "dev.acidcat.fixture"
        minSdk = 36
        targetSdk = 37
        versionCode = 1
        versionName = "0.0.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging {
        resources.excludes += setOf("META-INF/INDEX.LIST", "META-INF/io.netty.versions.properties")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// The app functions serve the target android of the catalog that the Kotlin core writes for the fixture.
acidCatAppFunctions {
    catalog.set(file("../../core-kotlin/fixture/fixture.acidcat.json"))
    target.set("android")
    packageName.set("dev.acidcat.fixture.android.functions")
    serviceName.set("FixtureAppFunctionService")
    provider.set("dev.acidcat.fixture.android.FixtureProvider")
}

dependencies {
    implementation(project(":acid-cat-appfunctions"))
    implementation("dev.acidcat:fixture")
    ksp(libs.appfunctions.compiler)
}
