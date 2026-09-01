# Active Together Android Companion

Native Android companion MVP for syncing exercise session durations from Health Connect into Active Together.

## What it does

- Signs in to the Active Together server with the same email/password as the web app.
- Stores the returned bearer session token in app preferences.
- Loads the member's teams and active challenges from `/api/mobile/bootstrap`.
- Requests Health Connect read access for exercise sessions.
- Reads exercise sessions from the last 30 days.
- Uploads whole-minute durations to `/api/health/import` with stable `source_ref` values so repeated syncs are idempotent.

## Local testing

1. Start the web/server app:

   ```powershell
   .\start-local.ps1
   ```

2. In Android Studio, open `companion/android`.
3. Run the app on a physical Android device or emulator with Health Connect available.
4. Use server URL `http://10.0.2.2:3000` for the Android emulator, or your computer's LAN URL for a physical device.
5. Sign in with `admin@example.com` / `ChangeMe123!`.
6. Create or join at least one team in the web app before syncing.

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

The companion reads only exercise session records and uploads only:

- team ID
- challenge ID
- activity type
- whole minutes
- activity date
- stable source reference

It does not upload routes, heart rate, calories, medical records, GPS data, or raw Health Connect records.
