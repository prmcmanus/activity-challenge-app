import Foundation
import Observation
import BackgroundTasks
import Security

/// Settings in UserDefaults; the session token in the Keychain (this device only, readable once the phone has
/// been unlocked since starting, so background sync still works). A token an older version kept in UserDefaults
/// moves across the first time it's read.
struct Prefs {
    private static let d = UserDefaults.standard
    static var token: String? {
        get {
            if let old = d.string(forKey: "token"), !old.isEmpty { if Keychain.set(old) { d.removeObject(forKey: "token") }; return old }
            return Keychain.get().flatMap { $0.isEmpty ? nil : $0 }
        }
        set {
            d.removeObject(forKey: "token")
            if let v = newValue, !v.isEmpty { if !Keychain.set(v) { d.set(v, forKey: "token") } } else { Keychain.delete() }
        }
    }
    static var email: String { get { d.string(forKey: "email") ?? "" } set { d.set(newValue, forKey: "email") } }
    static var autoSync: Bool { get { d.bool(forKey: "autoSync") } set { d.set(newValue, forKey: "autoSync") } }
    /// Upload GPS routes with workouts. Off by default: a route is precise location data.
    static var includeRoutes: Bool { get { d.bool(forKey: "includeRoutes") } set { d.set(newValue, forKey: "includeRoutes") } }
    static var preferredUnit: String { get { d.string(forKey: "preferredUnit") ?? "mi" } set { d.set(newValue, forKey: "preferredUnit") } }
    static var lastSyncSummary: String { get { d.string(forKey: "lastSyncSummary") ?? "" } set { d.set(newValue, forKey: "lastSyncSummary") } }
    /// An invite link opened before signing in, kept until the person has signed in and decided.
    static var pendingInvite: String? { get { d.string(forKey: "pendingInvite") } set { d.set(newValue, forKey: "pendingInvite") } }
}

/// The session token as a generic-password Keychain item.
private enum Keychain {
    private static let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                              kSecAttrService as String: "team.activetogether.companion.session",
                                              kSecAttrAccount as String: "session"]
    static func get() -> String? {
        var q = base; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    @discardableResult static func set(_ value: String) -> Bool {
        delete()
        var q = base
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    static func delete() { SecItemDelete(base as CFDictionary) }
}

/// A device workout and every challenge it could go into.
struct Candidate: Hashable {
    let workout: DeviceWorkout
    /// Challenges whose dates include this workout and that I can log into (a team if it needs one).
    let fits: [Challenge]
    /// Of those, the ones it is already in.
    let alreadyIn: Set<Int>
    var outstanding: [Challenge] { fits.filter { !alreadyIn.contains($0.id) } }
}

/// One workout in the sync review, with what the person has chosen for it.
@Observable final class ReviewItem: Identifiable {
    let candidate: Candidate
    var id: String { candidate.workout.sourceRef }
    var include: Bool
    var type: String
    var unit: String
    var distanceText: String
    var distanceTyped = false
    var into: Set<Int>
    private var distanceChallengesOffered: Bool

    init(_ c: Candidate, unit: String) {
        candidate = c
        let w = c.workout
        include = !c.outstanding.isEmpty
        type = w.type
        self.unit = unit
        distanceText = w.distanceMeters.map { String(format: "%.2f", $0 / unitMeters(unit)) } ?? ""
        into = Set(c.outstanding.filter { !$0.measuresDistance || w.distanceMeters != nil }.map(\.id))
        distanceChallengesOffered = w.distanceMeters != nil
    }
    func distanceEdited(_ text: String) {
        distanceText = text; distanceTyped = true
        if !distanceChallengesOffered, distanceMeters() != nil {
            distanceChallengesOffered = true
            candidate.outstanding.filter(\.measuresDistance).forEach { into.insert($0.id) }
        }
    }
    func distanceMeters() -> Double? {
        guard let v = Double(distanceText.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")), v > 0 else { return nil }
        return v * unitMeters(unit)
    }
    func switchUnit(_ u: String) {
        if !distanceTyped, let m = candidate.workout.distanceMeters { distanceText = String(format: "%.2f", m / unitMeters(u)) }
        unit = u
    }
}

/// What an automatic sync did.
struct SyncCounts {
    var workouts = 0, entries = 0, stepDays = 0
    var any: Bool { workouts > 0 || stepDays > 0 }
    var summary: String {
        var parts: [String] = []
        if workouts > 0 { parts.append("\(workouts) workout\(workouts == 1 ? "" : "s") (\(entries) challenge entr\(entries == 1 ? "y" : "ies"))") }
        if stepDays > 0 { parts.append("steps for \(stepDays) day\(stepDays == 1 ? "" : "s")") }
        return parts.isEmpty ? "nothing new" : parts.joined(separator: " and ")
    }
}

/// Matching device data to challenges and uploading it - shared by the review screen, automatic sync and the background task.
struct SyncPlanner {
    let api: API
    let health: HealthStore

    func plan(_ challenges: [Challenge], withRoutes: Bool) async throws -> [Candidate] {
        // Step challenges take daily totals (see syncSteps), not workouts.
        let open = challenges.filter { $0.target != nil && !$0.measuresSteps }
        guard let from = open.map(\.startDate).min(), let to = open.map(\.endDate).max() else { return [] }
        let workouts = try await health.readWorkouts(from: from, to: min(to, Day.today), withRoutes: withRoutes)
        let known = try await api.syncedIn(workouts.map(\.sourceRef))
        return workouts.map { w in Candidate(workout: w, fits: open.filter { $0.contains(w.day) && $0.accepts(w.type) }, alreadyIn: known[w.sourceRef] ?? []) }.filter { !$0.fits.isEmpty }
    }

    /// One workout into the chosen challenges - one record per challenge in one request; the route rides on the first only.
    func upload(_ w: DeviceWorkout, type: String, distanceMeters: Double?, route: [RoutePoint]?, into: [Challenge]) async throws -> ImportResult {
        let records = into.compactMap(\.target).enumerated().map { i, t in
            HealthRecord(target: t, activityType: type, minutes: w.minutes, distanceMeters: distanceMeters, activityDate: w.day.description,
                         sourceRef: w.sourceRef, startTime: w.startTime, endTime: w.endTime, route: i == 0 ? route : nil)
        }
        if records.isEmpty { return ImportResult(added: 0, skipped: 0, updated: 0) }
        return try await api.importHealth(records)
    }

    /// Every day's step total into each step challenge running that day, up to today. A day already sent is updated if it has grown.
    func syncSteps(_ challenges: [Challenge]) async throws -> ImportResult {
        let stepChallenges = challenges.filter { $0.measuresSteps && $0.target != nil && $0.startDate <= Day.today }
        guard let from = stepChallenges.map(\.startDate).min(), let to = stepChallenges.map(\.endDate).max() else { return ImportResult(added: 0, skipped: 0, updated: 0) }
        let daily = try await health.readDailySteps(from: from, to: to)
        let days = stepChallenges.flatMap { c in daily.filter { c.contains($0.key) }.map { StepDay(target: c.target!, date: $0.key, steps: $0.value) } }
        return try await api.importSteps(days)
    }

    /// The no-questions-asked version: each new workout into every challenge it fits; distance challenges skip workouts without a distance.
    func autoSync(withRoutes: Bool) async throws -> SyncCounts {
        let challenges = try await api.challenges()
        var counts = SyncCounts()
        if let s = try? await syncSteps(challenges) { counts.stepDays = s.added + s.updated }
        for c in try await plan(challenges, withRoutes: withRoutes) {
            let into = c.outstanding.filter { !$0.measuresDistance || c.workout.distanceMeters != nil }
            if into.isEmpty { continue }
            var route: [RoutePoint]? = nil
            if case .available(let pts) = c.workout.route { route = pts }
            let r = try await upload(c.workout, type: c.workout.type, distanceMeters: c.workout.distanceMeters, route: route, into: into)
            if r.added > 0 { counts.workouts += 1; counts.entries += r.added }
        }
        return counts
    }
}

/// Background refresh: iOS decides when (roughly every few hours, more often if the app is used). Health data is
/// only readable while the phone is unlocked, so a run while locked simply finds nothing new.
enum BackgroundSync {
    static let id = "team.activetogether.sync"
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: nil) { task in
            schedule()
            let work = Task {
                defer { task.setTaskCompleted(success: true) }
                guard Prefs.autoSync, let token = Prefs.token else { return }
                if let counts = try? await SyncPlanner(api: API(token: token), health: HealthStore()).autoSync(withRoutes: Prefs.includeRoutes), counts.any {
                    Prefs.lastSyncSummary = "Synced \(counts.summary) - \(Date().formatted(date: .abbreviated, time: .shortened))"
                }
            }
            task.expirationHandler = { work.cancel() }
        }
    }
    static func schedule() {
        guard Prefs.autoSync else { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: id); return }
        let r = BGAppRefreshTaskRequest(identifier: id)
        r.earliestBeginDate = Date(timeIntervalSinceNow: 3 * 3600)
        try? BGTaskScheduler.shared.submit(r)
    }
}

@MainActor @Observable final class AppModel {
    let health = HealthStore()
    var signedIn = Prefs.token != nil
    var me: Me?
    var challenges: [Challenge] = []
    var loadingChallenges = false
    var message: String?
    var activities: [MyActivity] = []
    var moreActivities = false
    var loadingActivities = false
    var leaderboards: [Int: Leaderboard] = [:]
    var details: [Int: ChallengeDetail] = [:]
    var topRefreshing = false
    var helpBadge = 0
    var review: [ReviewItem]?
    var syncBusy = false
    var syncStatus = Prefs.lastSyncSummary
    var pendingInvite: String? = Prefs.pendingInvite
    var update: AppRelease?

    var api: API { API(token: Prefs.token) }
    var planner: SyncPlanner { SyncPlanner(api: api, health: health) }

    init() { if signedIn { Task { await refreshAll() } } }

    /// Run a server call; an expired session signs out, anything else becomes a message.
    func call<T>(_ block: (API) async throws -> T) async -> T? {
        do { return try await block(api) }
        catch let e as APIError {
            if e.status == 401 { forceSignOut("Your session has expired. Please sign in again.") } else { message = e.message }
            return nil
        } catch {
            message = "Couldn't reach Active Together: \(error.localizedDescription)"
            return nil
        }
    }

    func refreshAll() async {
        loadingChallenges = true
        if let m = await call({ try await $0.me() }) { me = m }
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        loadingChallenges = false
        await loadActivities(reset: true)
        await refreshHelpBadge()
        await checkForUpdate()
        if Prefs.autoSync && !challenges.isEmpty { await autoSyncNow(quiet: true) }
    }

    /// Sign in with a password: an error, or (two-step sign-in) the ticket to send with the code.
    func signIn(email: String, password: String) async -> (error: String?, ticket: String?) {
        do {
            let email = email.trimmingCharacters(in: .whitespaces)
            let step = try await API(token: nil).login(email: email, password: password)
            Prefs.email = email
            if let ticket = step.ticket { return (nil, ticket) }
            signedInWith(step.token ?? "")
            return (nil, nil)
        } catch { return (error.localizedDescription, nil) }
    }
    /// Create an account in the app, then signed in as it (an invite link that brought them here is asked about next).
    func register(name: String, email: String, password: String, inviteCode: String?) async -> String? {
        do {
            let email = email.trimmingCharacters(in: .whitespaces)
            let token = try await API(token: nil).register(name: name.trimmingCharacters(in: .whitespaces), email: email, password: password, inviteCode: inviteCode)
            Prefs.email = email
            signedInWith(token)
            return nil
        } catch { return error.localizedDescription }
    }
    /// Sign in with Google or Apple: an error, the two-step ticket, or that an invite code is needed first.
    func socialSignIn(provider: String, credential: String, name: String?, inviteCode: String?) async -> (error: String?, ticket: String?, inviteNeeded: Bool) {
        do {
            let step = try await API(token: nil).socialLogin(provider: provider, credential: credential, name: name, inviteCode: inviteCode)
            if let ticket = step.ticket { return (nil, ticket, false) }
            signedInWith(step.token ?? "")
            return (nil, nil, false)
        } catch let e as APIError { return (e.message, nil, e.inviteRequired) }
        catch { return (error.localizedDescription, nil, false) }
    }
    /// The second step of two-step sign-in.
    func signInCode(ticket: String, code: String) async -> String? {
        do {
            signedInWith(try await API(token: nil).loginCode(ticket: ticket, code: code.trimmingCharacters(in: .whitespaces)))
            return nil
        } catch { return error.localizedDescription }
    }
    private func signedInWith(_ token: String) {
        Prefs.token = token
        signedIn = true
        Task { await refreshAll() }
    }
    func signOut() async {
        try? await api.logout()
        forceSignOut(nil)
    }
    /// Delete my account; on success I'm signed out with a note saying so.
    func deleteAccount(password: String) async -> Bool {
        guard await call({ try await $0.deleteAccount(password: password) }) != nil else { return false }
        forceSignOut("Your account has been deleted")
        return true
    }
    private func forceSignOut(_ msg: String?) {
        Prefs.token = nil
        signedIn = false
        me = nil; challenges = []; activities = []; review = nil; details = [:]; leaderboards = [:]
        message = msg
    }

    // Lists
    func loadActivities(reset: Bool) async {
        guard !loadingActivities else { return }
        loadingActivities = true
        if let r = await call({ try await $0.myActivities(offset: reset ? 0 : self.activities.count) }) {
            activities = reset ? r.0 : activities + r.0; moreActivities = r.1
        }
        loadingActivities = false
    }
    func refreshActivities() async {
        if let r = await call({ try await $0.myActivities(offset: 0, limit: max(30, self.activities.count)) }) { activities = r.0; moreActivities = r.1 }
    }
    func refreshTopLevel() async {
        if let m = await call({ try await $0.me() }) { me = m }
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        await refreshActivities()
        await refreshHelpBadge()
        await checkForUpdate()
    }
    /// Pull-to-refresh / refresh button on the tab screens. Says when it's done, so a refresh that changed nothing still visibly happened.
    func refreshTop() async {
        guard !topRefreshing else { return }
        topRefreshing = true
        let before = message
        await refreshTopLevel()
        topRefreshing = false
        if message == before { message = "Up to date" }
    }
    func refreshHelpBadge() async {
        if let b = await call({ try await $0.ticketBadge() }) { helpBadge = b.0 + (me?.isAdmin == true ? b.1 : 0) }
    }
    func checkForUpdate() async {
        if isAppStoreBuild { update = nil; return }
        let build = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0") ?? 0
        if let r = try? await api.iosRelease(), r.build > build { update = r } else { update = nil }
    }
    func afterChange() async {
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        await loadActivities(reset: true)
        leaderboards = [:]
    }

    // Challenges
    func loadLeaderboard(_ id: Int) async { if let b = await call({ try await $0.leaderboard(id) }) { leaderboards[id] = b } }
    func loadDetail(_ id: Int) async { if let d = await call({ try await $0.challengeDetail(id) }) { details[id] = d } }
    func refreshChallenge(_ id: Int) async {
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        await loadDetail(id)
        await loadLeaderboard(id)
    }
    func createChallenge(_ f: ChallengeFields, firstTeam: String) async -> Int? {
        guard let created = await call({ try await $0.createChallenge(f) }) else { return nil }
        let (id, code) = created
        if !f.individual && !firstTeam.trimmingCharacters(in: .whitespaces).isEmpty {
            _ = await call { try await $0.createTeam(challengeId: id, name: firstTeam.trimmingCharacters(in: .whitespaces)) }
        }
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        await loadDetail(id)
        message = "Challenge created. Invite code: \(code)"
        return id
    }
    func updateChallenge(_ id: Int, _ f: ChallengeFields) async -> Bool {
        guard await call({ try await $0.updateChallenge(id, f) }) != nil else { return false }
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        await loadDetail(id); leaderboards[id] = nil
        message = "Challenge saved"
        return true
    }
    func deleteChallenge(_ id: Int) async -> Bool {
        guard await call({ try await $0.deleteChallenge(id) }) != nil else { return false }
        challenges.removeAll { $0.id == id }; details[id] = nil
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        await refreshActivities()
        message = "Challenge deleted"
        return true
    }
    func join(_ code: String) async -> Int? {
        guard let joined = await call({ try await $0.join(code: code) }) else { return nil }
        let (id, name) = joined
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        await loadDetail(id)
        message = "Joined \(name.isEmpty ? "the challenge" : name)"
        return id
    }
    func createTeam(_ challengeId: Int, _ name: String) async -> Bool {
        guard await call({ try await $0.createTeam(challengeId: challengeId, name: name.trimmingCharacters(in: .whitespaces)) }) != nil else { return false }
        await refreshChallenge(challengeId); message = "Team created - you're in it"; return true
    }
    func joinTeam(_ challengeId: Int, _ teamId: Int) async {
        guard await call({ try await $0.joinTeam(teamId) }) != nil else { return }
        await refreshChallenge(challengeId); message = "Joined the team"
    }

    func leaveTeam(_ challengeId: Int, _ teamId: Int) async {
        guard await call({ try await $0.leaveTeam(teamId) }) != nil else { return }
        await refreshChallenge(challengeId); message = "You've left the team"
    }
    /// Leave a challenge; true once I'm out, so the screen can go back.
    func leaveChallenge(_ id: Int) async -> Bool {
        guard await call({ try await $0.leaveChallenge(id) }) != nil else { return false }
        challenges.removeAll { $0.id == id }; details[id] = nil; leaderboards[id] = nil
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        await refreshActivities()
        message = "You've left the challenge"
        return true
    }

    // Invites
    func openLink(_ url: URL) {
        guard let code = inviteCode(from: url) else { return }
        pendingInvite = code; Prefs.pendingInvite = code
    }
    func clearInvite() { pendingInvite = nil; Prefs.pendingInvite = nil }

    // Activity
    func deleteActivity(_ a: MyActivity) async -> Bool {
        guard await call({ try await $0.deleteActivity(a.id) }) != nil else { return false }
        activities.removeAll { $0.id == a.id }
        message = "Activity deleted"
        if let c = await call({ try await $0.challenges() }) { challenges = c }
        return true
    }
    /// Entries for the same workout in other challenges - matched on what a workout is, since each challenge has its own entry.
    func siblings(of a: MyActivity) -> [MyActivity] {
        activities.filter { $0.date == a.date && $0.type == a.type && $0.startTime == a.startTime && $0.minutes == a.minutes && $0.source == a.source && $0.comment == a.comment }
    }
    /// Edit a workout everywhere it's logged. An entry the change doesn't fit is left as it was and named in the message.
    func editWorkout(_ entries: [MyActivity], type: String, date: Day, minutes: Int?, distance: Double?, unit: String, start: String?, end: String?, comment: String) async -> Bool {
        var failed: [String] = []
        for e in entries {
            do { try await api.editActivity(e.id, type: type, date: date, minutes: minutes, distance: distance, unit: unit, start: start, end: end, comment: comment) }
            catch let x as APIError where x.status == 401 { forceSignOut("Your session has expired. Please sign in again."); return false }
            catch { failed.append("\(e.challengeName): \(error.localizedDescription)") }
        }
        await afterChange()
        message = failed.isEmpty ? "Activity updated" : "Not changed in " + failed.joined(separator: "; ")
        return failed.count < entries.count
    }

    // Sync
    func startReview() async {
        syncBusy = true; defer { syncBusy = false }
        syncStatus = "Reading Apple Health..."
        guard let fresh = await call({ try await $0.challenges() }) else { syncStatus = ""; return }
        challenges = fresh
        do {
            // Step counts need no review: send them straight away, then review workouts.
            let steps = try? await planner.syncSteps(fresh)
            let stepDays = (steps?.added ?? 0) + (steps?.updated ?? 0)
            let stepNote = stepDays > 0 ? "Updated steps for \(stepDays) day\(stepDays == 1 ? "" : "s"). " : ""
            if stepDays > 0 { message = stepNote.trimmingCharacters(in: .whitespaces) }
            let candidates = try await planner.plan(fresh, withRoutes: Prefs.includeRoutes)
            review = candidates.map { c in
                ReviewItem(c, unit: c.outstanding.first(where: \.measuresDistance)?.distanceUnit ?? c.fits.first(where: \.measuresDistance)?.distanceUnit ?? Prefs.preferredUnit)
            }
            syncStatus = stepNote + (candidates.isEmpty ? "No workouts in Apple Health fall within your challenges' dates." : "")
        } catch let e as APIError where e.status == 401 {
            forceSignOut("Your session has expired. Please sign in again.")
        } catch {
            syncStatus = "Couldn't read workouts: \(error.localizedDescription)"
        }
    }
    func cancelReview() { review = nil; syncStatus = "Sync cancelled. Nothing was uploaded." }
    func uploadReview() async {
        guard let items = review else { return }
        syncBusy = true; defer { syncBusy = false }
        var workouts = 0, entries = 0, skippedNoDistance = 0
        do {
            for item in items where item.include && !item.into.isEmpty {
                let chosen = item.candidate.fits.filter { item.into.contains($0.id) }
                let distance = item.distanceMeters()
                let into = chosen.filter { !$0.measuresDistance || distance != nil }
                skippedNoDistance += chosen.count - into.count
                if into.isEmpty { continue }
                var route: [RoutePoint]? = nil
                if case .available(let pts) = item.candidate.workout.route { route = pts }
                let r = try await planner.upload(item.candidate.workout, type: item.type, distanceMeters: distance, route: route, into: into)
                if r.added > 0 { workouts += 1; entries += r.added }
            }
            syncStatus = "Synced \(workouts) workout\(workouts == 1 ? "" : "s") into \(entries) challenge entr\(entries == 1 ? "y" : "ies")." +
                (skippedNoDistance > 0 ? " \(skippedNoDistance) distance-challenge entr\(skippedNoDistance == 1 ? "y was" : "ies were") left out for having no distance." : "")
            Prefs.lastSyncSummary = "\(syncStatus) - \(Date().formatted(date: .abbreviated, time: .shortened))"
            review = nil
            await afterChange()
        } catch {
            syncStatus = "Upload failed: \(error.localizedDescription)"
        }
    }
    /// Automatic sync, run now - on opening the app, or from the settings switch.
    func autoSyncNow(quiet: Bool = false) async {
        guard !syncBusy, health.isAvailable else { return }
        syncBusy = true; defer { syncBusy = false }
        do {
            let counts = try await planner.autoSync(withRoutes: Prefs.includeRoutes)
            if counts.any {
                syncStatus = "Synced \(counts.summary)."
                Prefs.lastSyncSummary = "\(syncStatus) - \(Date().formatted(date: .abbreviated, time: .shortened))"
                await afterChange()
            } else if !quiet { syncStatus = "Nothing new to sync." }
        } catch {
            if !quiet { syncStatus = "Automatic sync failed: \(error.localizedDescription)" }
        }
    }
    func setAutoSync(_ on: Bool) { Prefs.autoSync = on; BackgroundSync.schedule() }
}
