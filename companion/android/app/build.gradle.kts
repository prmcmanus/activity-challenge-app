plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.activetogether.companion"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.activetogether.companion"
        minSdk = 28
        targetSdk = 35
        versionCode = 5
        versionName = "0.5.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.health.connect:connect-client:1.1.0-alpha10")
}
