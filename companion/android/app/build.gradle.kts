plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.activetogether.companion"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.activetogether.companion"
        minSdk = 28
        targetSdk = 35
        versionCode = 10
        versionName = "1.4.0"
        buildConfigField("String", "SERVER_URL", "\"https://activetogether.team\"")
        manifestPlaceholders["cleartext"] = "false"
    }

    buildTypes {
        // What gets installed: shrunk (the full Material icon set alone is ~50MB unshrunk) and signed
        // with the same debug key as earlier builds, so it updates an existing install in place.
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
        // For trying the app on an emulator against a local server (http://10.0.2.2:<port> is the
        // host machine), with a tool that writes sample workouts into Health Connect. Never shipped:
        // its extra write permissions and seeding code live only in src/emulator.
        create("emulator") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".emulator"
            val local = (project.findProperty("localServer") as String?) ?: "http://10.0.2.2:3911"
            buildConfigField("String", "SERVER_URL", "\"$local\"")
            manifestPlaceholders["cleartext"] = "true"
            // -Pminify: shrink exactly as the release build does, to check R8 didn't break anything.
            if (project.hasProperty("minify")) {
                isDebuggable = false
                isMinifyEnabled = true
                proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            }
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
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
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.3")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.health.connect:connect-client:1.1.0-alpha10")
    // Maps: OpenStreetMap tiles, no API key needed (the web app uses the same tiles).
    implementation("org.osmdroid:osmdroid-android:6.1.20")
    // Avatars and team logos.
    implementation("io.coil-kt:coil-compose:2.7.0")
}
