# Active Together for Android

The Active Together app for Android, written in Kotlin with Jetpack Compose (Material 3, in the web
app's red and yellow, with a dark theme). It talks to `https://activetogether.team`.

## What it does

- **Challenges:** every challenge you're in, with your total, its dates and what it measures; open
  one for its description and team / individual leaderboards; tap a person to see their profile.
- **Activity:** everything you've logged across all challenges, newest first. A workout logged into
  several challenges shows once, listing them; open it to see its route on an OpenStreetMap map
  (if it has one), edit it (saved in every challenge it's logged in) or remove it from a challenge.
- **Log activity:** type, date, optional start/finish (fills in minutes), distance in miles or km,
  minutes and a comment, counted in every challenge running on that day (tick the ones you want).
- **Sync:** reads workouts from Health Connect for the span of your challenges and lists them for
  review: tick which to send, change the activity type, type or correct the distance (miles/km),
  and choose the challenges each counts in - all the ones it fits are pre-selected, already-synced
  ones are shown as such, and distance challenges are left out for a workout with no distance until
  one is typed. With routes switched on, a route Health Connect shares is included; a route recorded
  by another app needs a tap ("Add route from ...") because Health Connect asks consent per workout.
- **Automatic sync** (Me -> Sync settings): new workouts go into every challenge they fit, every
  1-24 hours in the background where Health Connect allows background reading, and each time the
  app opens. A notification says what was synced.
- **Me:** your profile exactly as challenge-mates see it, with Edit (photo, name, about me, sharing
  level - Private / Totals / Full - email, password); sync settings; sign out.
- **Help** (? in the top bar, with a badge for new replies): quick answers, report a bug or request a
  feature (with an optional screenshot; phone model and app version are added), and your tickets
  with their status, outcome and conversation. Admins also get the support dashboard.
- Pull down to refresh on every page.

Health Connect permissions: exercise (required), distance, history older than 30 days (for
challenges that started earlier) and background reading (for automatic sync) - each asked for only
when needed. Nothing else is read.

## Building

The APK to install is the shrunk release build, signed with the debug key so it updates in place:

```powershell
./build-local.ps1 -Task assembleRelease -JavaHome <jdk-17> -GradleHome <gradle-8.9>
# -> app/build/outputs/apk/release/app-release.apk
```

On a machine whose project folder is synced by OneDrive, build from a copy outside it - OneDrive
locks files under `app/build` and Gradle fails with "Unable to delete directory".

## Trying it on an emulator

The `emulator` build type points at a local server (`http://10.0.2.2:3911` by default, override
with `-PlocalServer=...`) and adds `SeedActivity`, which writes sample workouts into Health Connect:

```powershell
gradle assembleEmulator
adb install -r app/build/outputs/apk/emulator/app-emulator.apk
adb shell am start -S -n com.activetogether.companion.emulator/com.activetogether.companion.SeedActivity              # 3 sample workouts
adb shell am start -S -n com.activetogether.companion.emulator/com.activetogether.companion.SeedActivity --ez fresh true    # one new run
adb shell am start -S -n com.activetogether.companion.emulator/com.activetogether.companion.SeedActivity --ez runSync true  # background sync in 20s
```

Behind a TLS-inspecting proxy, put its root certificate (PEM) at
`app/src/emulator/res/raw/corp_root_ca.pem` (git-ignored) so map tiles load on the emulator; the
emulator build trusts it, the release build never does.

## Build prerequisites

- Android Studio with Android SDK installed
- Gradle **wrapper** (included in this folder)
- Java 17+ for Gradle/AGP 8.7

If you saw:

`Plugin [id: 'org.jetbrains.kotlin.android', version: '2.0.21'] was not found`

that is normally caused by opening without the wrapper / with an old Gradle runtime.

### Fix in Android Studio

1. Open the `companion/android` folder as a project root.
2. In **Settings > Build, Execution, Deployment > Build Tools > Gradle**:
   - Set **Gradle JDK** to Java 17+.
   - Set Gradle to **Use Gradle from: gradle-wrapper.properties**.
3. Sync project again.

> **Note:** Older Android Studio releases (e.g. 2020.3) bundle a **Java 11 JRE**
> (`...\Android Studio\jre`), not a JBR, and it isn't listed as a selectable
> "Gradle JDK" until you add it. Use **Add JDK...** in that same dropdown and
> browse to a Java 17+ install instead (see the corporate-proxy section below for
> why a *portable* JDK 17 — not the bundled one — is required on networks with
> TLS inspection, since you likely can't write to `C:\Program Files\...` without
> admin rights to fix the bundled JRE's trust store).

### Corporate networks with a TLS-inspecting proxy (e.g. Zscaler)

If the plugin-not-found error persists even with Java 17+/Gradle 8.9+ correctly
configured, and/or you see:

```
javax.net.ssl.SSLHandshakeException: PKIX path building failed ...
sun.security.provider.certpath.SunCertPathBuilderException: unable to find valid
certification path to requested target
```

this is corporate TLS inspection (Zscaler) intercepting HTTPS to
`repo.maven.apache.org`, `plugins.gradle.org`, `services.gradle.org`, etc. Windows
already trusts the intercepting certificate (via a GPO-pushed root CA), but the
JDK has its own separate `cacerts` truststore that doesn't — and the JDK also
doesn't automatically use the OS/PAC proxy configuration the way `curl`/browsers do.

**One-time fix per JDK install:**

1. Import the Zscaler CA certificates into the JDK's `cacerts`:
   ```powershell
   .\import-zscaler-certs.ps1 -JavaHome "C:\path\to\jdk-17"
   ```
   This connects to `repo.maven.apache.org`, captures the certificate chain
   presented by the intercepting proxy, and imports the CA certs (not the leaf)
   via `keytool`.

2. Build with `java.net.useSystemProxies=true` so Java consults the same PAC-based
   proxy configuration Windows/curl already use:
   ```powershell
   .\build-local.ps1 -JavaHome "C:\path\to\jdk-17" -GradleHome "C:\path\to\gradle-8.9"
   ```
   or manually:
   ```powershell
   $env:JAVA_HOME = "C:\path\to\jdk-17"
   $env:GRADLE_OPTS = "-Djava.net.useSystemProxies=true"
   .\gradlew.bat assembleDebug --no-daemon
   ```
   > Setting a fixed `-Dhttps.proxyHost`/`-Dhttps.proxyPort` does **not** work on
   > some corporate networks — the explicit proxy can return `403 Forbidden` for
   > these specific hosts even though they're reachable directly (with transparent
   > inspection). `useSystemProxies=true` lets Java replicate curl's PAC-based
   > per-host routing instead of forcing one fixed proxy.

3. If the Gradle **wrapper** itself can't download the Gradle distribution due to
   the same SSL issue, download `gradle-8.9-bin.zip` manually with `curl.exe`
   (which uses the Windows cert store and succeeds where Java doesn't), extract it,
   and use that extracted `gradle.bat` directly until the cacerts fix above is
   applied — then the wrapper will work too.

4. If the build then fails with a message about SDK licenses not accepted
   (`build-tools;34.0.0`, `platforms;android-35`), accept them non-interactively:
   ```powershell
   $licDir = "$env:LOCALAPPDATA\Android\Sdk\licenses"
   New-Item -ItemType Directory -Path $licDir -Force | Out-Null
   Set-Content "$licDir\android-sdk-license" "8933bad161af4178b1185d1a37fbf41ea5269c55`n24333f8a63b6825ea9c5514f83c2829b004d1fee"
   Set-Content "$licDir\android-sdk-preview-license" "84831b9409646a918e30573bab4c9c91346d8abd"
   ```
   (These are the standard, publicly documented Android SDK license hashes.)

**For Android Studio itself:** its embedded JRE/JBR has its own separate `cacerts`
and, on many corporate laptops, lives under `C:\Program Files\...` where you don't
have write access without admin rights — so `import-zscaler-certs.ps1` will fail
with `Access is denied` when pointed at it. Don't fight that; instead make Android
Studio use your own portable, already-fixed JDK 17:

1. Run `import-zscaler-certs.ps1` once against your **portable** JDK 17 (not
   Android Studio's bundled one).
2. In Android Studio: **Settings > Build, Execution, Deployment > Build Tools >
   Gradle**, set **Gradle JDK** to **Add JDK...** and browse to that portable
   JDK 17's folder.
3. So the fix also applies without per-project settings, add these two lines to
   your **global** `%USERPROFILE%\.gradle\gradle.properties` (create the file/
   folder if needed — this is machine-local and not part of the repo):
   ```properties
   org.gradle.java.home=C:/path/to/your/portable/jdk-17
   org.gradle.jvmargs=-Djava.net.useSystemProxies=true
   ```
   This makes both the IDE's Gradle sync/build **and** any `.\gradlew.bat` run
   from a terminal use the fixed JDK and proxy setting automatically, with no
   need to set `JAVA_HOME`/`GRADLE_OPTS` by hand each time (a plain user-level
   `JAVA_HOME` environment variable pointing at the same JDK is still useful as
   a fallback for other tools).
4. Re-sync the project in Android Studio.

This exact combination (portable JDK 17 with Zscaler CAs imported +
`org.gradle.java.home` + `useSystemProxies=true` in the global `gradle.properties`)
was verified to produce a successful `assembleDebug` build via both the Gradle
wrapper and Android Studio's own project settings.

### "Unable to locate adb" even though Gradle sync succeeds

If Android Studio's Gradle sync finishes successfully (check
`Help > Show Log in Explorer` → `idea.log` for "Gradle sync finished") but you
still see:

```
Unable to locate adb in project/module settings. Locations searched:
    ADB_PATH_PROPERTY (android.adb.path): '<not set>'
    Android SDK location from first Android Module in Project: <not present>
```

this almost always means **Android Studio itself is too old** for this
project's toolchain (AGP 8.7.3 / Gradle 8.9 / Kotlin 2.0.21). Old Studio
versions (e.g. 2020.3 "Arctic Fox") can successfully invoke Gradle and get a
"successful" sync, but their own IDE-side project-model code doesn't know how
to parse the resulting module structure from newer AGP versions, so no
Android facet/SDK ever gets attached to the module — hence no adb.

**Fix: use a newer Android Studio, installed portably (no admin rights
needed):**

1. Download a current release zip (not the `.exe` installer) — e.g. Android
   Studio "Ladybug" 2024.2.1.12, confirmed compatible with this project's
   toolchain:
   ```powershell
   $url = "https://redirector.gvt1.com/edgedl/android/studio/ide-zips/2024.2.1.12/android-studio-2024.2.1.12-windows.zip"
   Start-BitsTransfer -Source $url -Destination "$env:TEMP\android-studio.zip"
   ```
2. Extract it to a folder you own (no `Program Files`):
   ```powershell
   Expand-Archive -Path "$env:TEMP\android-studio.zip" -DestinationPath "$env:USERPROFILE\AndroidStudioPortable" -Force
   ```
3. Launch it directly — no installer/admin needed:
   ```
   %USERPROFILE%\AndroidStudioPortable\android-studio\bin\studio64.exe
   ```
4. On first run, skip/decline importing settings from the old install if
   asked, then open `companion/android`.
5. If Gradle JDK isn't auto-detected, set it again as above (**Settings >
   Build, Execution, Deployment > Build Tools > Gradle** → Gradle JDK → your
   portable JDK 17).
6. Sync, then confirm **File > Project Structure > SDK Location** shows your
   Android SDK path (e.g. `%LOCALAPPDATA%\Android\Sdk`) and that
   `platform-tools\adb.exe` exists there. Run/Debug should now work.

You can keep the old Android Studio installed; the portable copy is
independent and doesn't touch it.

## Privacy boundary

The app reads only exercise sessions, the distance recorded during them and - if "Include GPS routes" is on - their routes, and uploads only:

- challenge ID (and team ID in a team challenge)
- activity type
- whole minutes
- distance in metres (when recorded and permitted)
- activity date
- clock start/finish time (only when the session doesn't cross midnight; otherwise omitted)
- stable source reference
- the route's points (latitude, longitude, time, altitude) when routes are on; only you can see them

It does not upload heart rate, calories, medical records or raw Health Connect records.
