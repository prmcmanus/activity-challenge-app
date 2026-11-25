plugins {
    id("com.android.application") version "9.5.3" apply false
    // AGP 9 compiles Kotlin itself (built-in Kotlin), so the app module no longer applies
    // org.jetbrains.kotlin.android. Declaring it here only sets the Kotlin version AGP uses,
    // which would otherwise be the older one AGP ships with.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
