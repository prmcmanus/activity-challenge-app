# osmdroid looks up its tile sources and some classes reflectively.
-keep class org.osmdroid.** { *; }
-dontwarn org.osmdroid.**
# org.json is part of Android; nothing to keep. Health Connect and WorkManager ship their own rules.
