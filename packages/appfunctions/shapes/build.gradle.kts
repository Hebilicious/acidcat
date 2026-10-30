plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    id("dev.acidcat.appfunctions")
}

description = "Compile the app functions of shapes.acidcat.json, a catalog with one capability for each kind of schema."

android {
    namespace = "dev.acidcat.shapes"
    compileSdk = 37
    defaultConfig {
        minSdk = 36
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

acidCatAppFunctions {
    catalog.set(file("shapes.acidcat.json"))
    target.set("android")
    packageName.set("dev.acidcat.shapes.functions")
    serviceName.set("ShapesAppFunctionService")
    provider.set("dev.acidcat.shapes.ShapesProvider")
}

dependencies {
    implementation(project(":acid-cat-appfunctions"))
    ksp(libs.appfunctions.compiler)
}
