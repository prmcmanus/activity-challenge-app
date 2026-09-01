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

## Privacy boundary

The companion reads only exercise session records and uploads only:

- team ID
- challenge ID
- activity type
- whole minutes
- activity date
- stable source reference

It does not upload routes, heart rate, calories, medical records, GPS data, or raw Health Connect records.
