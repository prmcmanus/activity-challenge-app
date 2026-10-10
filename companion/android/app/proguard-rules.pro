# osmdroid looks up its tile sources and some classes reflectively.
-keep class org.osmdroid.** { *; }
-dontwarn org.osmdroid.**
# org.json is part of Android; nothing to keep. Health Connect and WorkManager ship their own rules.

# Sign in with Google (Credential Manager): its Play Services provider is found by reflection.
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** { *; }
