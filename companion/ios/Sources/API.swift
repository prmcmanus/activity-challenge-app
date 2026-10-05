import Foundation

/// The one server this app talks to. A build setting can point a test build elsewhere.
let serverURL: String = (Bundle.main.object(forInfoDictionaryKey: "ATServerURL") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "https://activetogether.team"

/// Absolute URL for a server path such as /uploads/abc.png.
func serverURLFor(_ path: String?) -> URL? {
    guard let path, !path.isEmpty else { return nil }
    return URL(string: path.hasPrefix("http") ? path : serverURL + path)
}

// MARK: - JSON helpers (the server's field names, read leniently like the Android app does)

struct J {
    let o: [String: Any]
    init(_ o: [String: Any]) { self.o = o }
    init?(any: Any?) { guard let d = any as? [String: Any] else { return nil }; o = d }
    func has(_ k: String) -> Bool { o[k] != nil && !(o[k] is NSNull) }
    func str(_ k: String) -> String? { if let s = o[k] as? String, !s.isEmpty { return s }; if let n = o[k] as? NSNumber { return n.stringValue }; return nil }
    func string(_ k: String, _ d: String = "") -> String { str(k) ?? d }
    func int(_ k: String, _ d: Int = 0) -> Int { (o[k] as? NSNumber)?.intValue ?? Int(str(k) ?? "") ?? d }
    func intOrNil(_ k: String) -> Int? { has(k) ? int(k) : nil }
    func double(_ k: String, _ d: Double = 0) -> Double { (o[k] as? NSNumber)?.doubleValue ?? Double(str(k) ?? "") ?? d }
    func doubleOrNil(_ k: String) -> Double? { has(k) ? double(k) : nil }
    func bool(_ k: String) -> Bool { (o[k] as? NSNumber)?.boolValue ?? false }
    func obj(_ k: String) -> J? { J(any: o[k]) }
    func arr(_ k: String) -> [J] { (o[k] as? [Any] ?? []).compactMap { J(any: $0) } }
    func day(_ k: String) -> Day { Day(string(k)) ?? Day.today }
}

/// A calendar day as the server sends it (YYYY-MM-DD), compared and shown in the phone's time zone.
struct Day: Comparable, Hashable, CustomStringConvertible {
    let y: Int, m: Int, d: Int
    init(y: Int, m: Int, d: Int) { self.y = y; self.m = m; self.d = d }
    init?(_ s: String) {
        let p = s.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        y = p[0]; m = p[1]; d = p[2]
    }
    init(_ date: Date) {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        y = c.year!; m = c.month!; d = c.day!
    }
    static var today: Day { Day(Date()) }
    var date: Date { Calendar.current.date(from: DateComponents(year: y, month: m, day: d))! }
    var description: String { String(format: "%04d-%02d-%02d", y, m, d) }
    func adding(days: Int) -> Day { Day(Calendar.current.date(byAdding: .day, value: days, to: date)!) }
    static func < (a: Day, b: Day) -> Bool { (a.y, a.m, a.d) < (b.y, b.m, b.d) }
}

// MARK: - Models

/// Who can see what on my profile: "private" (name, photo), "summary" (+ totals, rank), "full" (+ recent activity).
struct Me: Equatable {
    var id: Int, name: String, email: String, avatarURL: String?, bio: String?, sharing: String, role: String
    var isAdmin: Bool { role == "global_admin" }
}

/// "minutes", "distance" or "steps".
enum Measure: String, CaseIterable, Identifiable {
    case minutes, distance, steps
    var id: String { rawValue }
    init(_ s: String?) { self = Measure(rawValue: s ?? "") ?? .minutes }
    var label: String { switch self { case .minutes: "Active minutes"; case .distance: "Distance"; case .steps: "Steps" } }
}

struct MyTeam: Hashable { let id: Int; let name: String }
struct Target: Hashable { let challengeId: Int; let teamId: Int? }

/// A challenge I belong to, as the dashboard reports it.
struct Challenge: Identifiable, Hashable {
    let id: Int, name: String, descriptionHTML: String, startDate: Day, endDate: Day
    let measure: Measure, distanceUnit: String, individual: Bool, role: String
    let myTeams: [MyTeam], myMinutes: Double, myDistance: Double, mySteps: Double
    var measuresDistance: Bool { measure == .distance }
    var measuresSteps: Bool { measure == .steps }
    func contains(_ day: Day) -> Bool { day >= startDate && day <= endDate }
    /// Where my activity goes: no team if individuals-only, else my (first) team. Nil if I have no team yet.
    var target: Target? { individual ? Target(challengeId: id, teamId: nil) : myTeams.first.map { Target(challengeId: id, teamId: $0.id) } }
    var isActive: Bool { Day.today <= endDate }
}

struct TeamInfo: Identifiable, Hashable { let id: Int, name: String, imageURL: String?, members: Int, mine: Bool, canManage: Bool, inviteCode: String? }

/// The full challenge record: what owners edit, the invite code, and its teams. role is "admin" for a global admin who hasn't joined.
struct ChallengeDetail: Hashable {
    let id: Int, name: String, descriptionHTML: String, startDate: Day, endDate: Day
    let measure: Measure, distanceUnit: String, individual: Bool, role: String
    let canManage: Bool, inviteCode: String, teams: [TeamInfo]
    var asChallenge: Challenge {
        Challenge(id: id, name: name, descriptionHTML: descriptionHTML, startDate: startDate, endDate: endDate, measure: measure, distanceUnit: distanceUnit,
                  individual: individual, role: role, myTeams: teams.filter(\.mine).map { MyTeam(id: $0.id, name: $0.name) }, myMinutes: 0, myDistance: 0, mySteps: 0)
    }
}

struct ChallengeFields {
    var name: String, description: String?, startDate: Day, endDate: Day, measure: Measure, distanceUnit: String, individual: Bool
}

/// A leaderboard row; userId is set for people (tap to see their profile), nil for teams.
struct Standing: Hashable { let name: String, minutes: Double, distance: Double, steps: Double, imageURL: String?, userId: Int? }
struct Leaderboard { let teams: [Standing]; let users: [Standing] }

struct MyActivity: Identifiable, Hashable {
    let id: Int, challengeId: Int, challengeName: String, teamName: String?, type: String
    let minutes: Double?, distance: Double?, steps: Int?, distanceUnit: String, measure: Measure
    let date: Day, startTime: String?, endTime: String?, comment: String?, source: String, hasRoute: Bool
}

struct ProfileChallenge: Hashable { let id: Int, name: String, startDate: Day, endDate: Day, measure: Measure, distanceUnit: String, team: String?, minutes: Double, distance: Double, steps: Double, rank: Int, of: Int }
struct ProfileActivity: Hashable { let type: String, minutes: Double?, distance: Double?, steps: Int?, distanceUnit: String, measure: Measure, date: Day, startTime: String?, comment: String?, challengeName: String }
/// Someone's profile as a challenge-mate sees it. challenges/activities are nil when their sharing level hides them.
struct Profile { let id: Int, name: String, avatarURL: String?, bio: String?, memberSince: String, sharing: String, isSelf: Bool, challenges: [ProfileChallenge]?, activities: [ProfileActivity]? }

/// Help & support. type: bug | feature | question; status: new | in_progress | planned | done | declined.
struct Ticket: Identifiable, Hashable {
    let id: Int, type: String, title: String, description: String, status: String, resolution: String?, imageURL: String?, clientInfo: String?
    let createdAt: String, updatedAt: String, reporterName: String, reporterEmail: String?, commentCount: Int, unread: Bool, mine: Bool
}
struct TicketComment: Identifiable, Hashable { let id: Int, body: String, internalNote: Bool, createdAt: String, authorName: String, fromSupport: Bool }
struct TicketList { let tickets: [Ticket]; let counts: [String: Int]; let openByType: [String: Int] }

struct InvitePreview {
    let code: String, isTeam: Bool, challengeId: Int, challengeName: String, startDate: Day, endDate: Day
    let measure: Measure, distanceUnit: String, individual: Bool, members: Int, teamName: String?, member: Bool?, inTeam: Bool?
    var alreadyIn: Bool { member == true && (!isTeam || inTeam == true) }
}

struct AppRelease { let version: String; let build: Int }

struct AdminUser: Identifiable, Hashable {
    let id: Int, name: String, email: String, role: String, avatarURL: String?, createdAt: String
    let challenges: Int, activities: Int, lastActivity: String?, tickets: Int, deactivatedAt: String?
    var isAdmin: Bool { role == "global_admin" }
}
struct AdminChallenge: Identifiable, Hashable {
    let id: Int, name: String, startDate: Day, endDate: Day, measure: Measure, distanceUnit: String, individual: Bool
    let inviteCode: String, owners: String?, members: Int, teams: Int, activities: Int, state: String, purgeDate: String
}

/// One route point: latitude, longitude, and time (epoch ms) and altitude (m) when known.
struct RoutePoint: Hashable { let lat: Double, lon: Double, timeMs: Int64?, altitude: Double? }

/// A device workout ready to upload into one challenge.
struct HealthRecord {
    let target: Target, activityType: String, minutes: Int, distanceMeters: Double?, activityDate: String
    let sourceRef: String, startTime: String, endTime: String, route: [RoutePoint]?
}
struct StepDay { let target: Target; let date: Day; let steps: Int }
struct ImportResult { let added: Int, skipped: Int, updated: Int }

/// The invite code in an invite link: https://.../join/CODE or activetogether://join/CODE.
func inviteCode(from url: URL) -> String? {
    let parts = url.pathComponents.filter { $0 != "/" }
    var code: String?
    if url.scheme == "activetogether", url.host == "join" { code = parts.first }
    else if (url.scheme == "https" || url.scheme == "http"), parts.count >= 2, parts[0] == "join" { code = parts[1] }
    guard let c = code?.uppercased().filter({ $0.isLetter || $0.isNumber }), (4...32).contains(c.count) else { return nil }
    return c
}

// MARK: - Client

/// A failed request, keeping the HTTP status so an expired session (401) can send the user back to sign in.
struct APIError: LocalizedError {
    let status: Int, message: String
    var errorDescription: String? { message }
}

final class API: @unchecked Sendable {
    let token: String?
    let base: String
    init(token: String?, base: String = serverURL) { self.token = token; self.base = base }

    private func unit(_ j: J) -> String { j.str("distance_unit") == "km" ? "km" : "mi" }

    // Session
    /// The mobile login: the web one needs a reCAPTCHA token from a page this app never shows.
    func login(email: String, password: String) async throws -> String {
        try await request("/api/mobile/login", "POST", ["email": email, "password": password]).string("sessionToken")
    }
    func logout() async throws { _ = try await request("/api/logout", "POST", [:]) }
    func me() async throws -> Me {
        let r = try await request("/api/me")
        guard let u = r.obj("user") else { throw APIError(status: 401, message: "Please sign in again") }
        return parseMe(u)
    }
    private func parseMe(_ u: J) -> Me {
        Me(id: u.int("id"), name: u.string("name"), email: u.string("email"), avatarURL: u.str("avatar_url") ?? u.str("avatarUrl"),
           bio: u.str("bio"), sharing: u.str("profile_sharing") ?? "summary", role: u.str("role") ?? "member")
    }

    // Challenges
    func challenges() async throws -> [Challenge] {
        try await request("/api/dashboard").arr("challenges").map { c in
            Challenge(id: c.int("id"), name: c.string("name"), descriptionHTML: c.string("description"), startDate: c.day("start_date"), endDate: c.day("end_date"),
                      measure: Measure(c.str("metric")), distanceUnit: unit(c), individual: c.str("participation") == "individual", role: c.str("role") ?? "member",
                      myTeams: c.arr("teams").map { MyTeam(id: $0.int("id"), name: $0.string("name")) },
                      myMinutes: c.double("myMinutes"), myDistance: c.double("myDistance"), mySteps: c.double("mySteps"))
        }
    }
    func challengeDetail(_ id: Int) async throws -> ChallengeDetail {
        let c = try await request("/api/challenges/\(id)")
        return ChallengeDetail(id: c.int("id"), name: c.string("name"), descriptionHTML: c.string("description"), startDate: c.day("start_date"), endDate: c.day("end_date"),
                               measure: Measure(c.str("metric")), distanceUnit: unit(c), individual: c.str("participation") == "individual", role: c.str("role") ?? "member",
                               canManage: c.bool("canManage"), inviteCode: c.string("invite_code"),
                               teams: c.arr("teams").map { t in TeamInfo(id: t.int("id"), name: t.string("name"), imageURL: t.str("image_url"), members: t.int("members"),
                                                                       mine: t.bool("mine"), canManage: t.bool("canManage"), inviteCode: t.str("invite_code")) })
    }
    private func challengeBody(_ f: ChallengeFields) -> [String: Any] {
        var b: [String: Any] = ["name": f.name, "start_date": f.startDate.description, "end_date": f.endDate.description, "metric": f.measure.rawValue,
                                "distance_unit": f.distanceUnit, "participation": f.individual ? "individual" : "teams"]
        if let d = f.description { b["description"] = d }
        return b
    }
    func createChallenge(_ f: ChallengeFields) async throws -> (Int, String) {
        let r = try await request("/api/challenges", "POST", challengeBody(f)); return (r.int("id"), r.string("invite_code"))
    }
    func updateChallenge(_ id: Int, _ f: ChallengeFields) async throws { _ = try await request("/api/challenges/\(id)", "PATCH", challengeBody(f)) }
    func deleteChallenge(_ id: Int) async throws { _ = try await request("/api/challenges/\(id)", "DELETE") }
    func join(code: String) async throws -> (Int, String) {
        let r = try await request("/api/join", "POST", ["code": code.trimmingCharacters(in: .whitespaces)]); return (r.int("challengeId"), r.string("name"))
    }
    func createTeam(challengeId: Int, name: String) async throws { _ = try await request("/api/teams", "POST", ["challenge_id": challengeId, "name": name]) }
    func joinTeam(_ id: Int) async throws { _ = try await request("/api/teams/\(id)/join", "POST", [:]) }
    func invitePreview(_ code: String) async throws -> InvitePreview {
        let r = try await request("/api/join/preview?code=" + (code.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? code))
        let c = r.obj("challenge") ?? J([:]), t = r.obj("team")
        return InvitePreview(code: r.string("code"), isTeam: r.str("type") == "team", challengeId: c.int("id"), challengeName: c.string("name"),
                             startDate: c.day("start_date"), endDate: c.day("end_date"), measure: Measure(c.str("metric")), distanceUnit: unit(c),
                             individual: c.str("participation") == "individual", members: c.int("members"), teamName: t?.str("name"),
                             member: r.has("member") ? r.bool("member") : nil, inTeam: r.has("inTeam") ? r.bool("inTeam") : nil)
    }
    func leaderboard(_ id: Int) async throws -> Leaderboard {
        let r = try await request("/api/challenges/\(id)/leaderboard")
        func rows(_ a: [J], people: Bool) -> [Standing] {
            a.map { x in Standing(name: x.string("name"), minutes: x.double("minutes"), distance: x.double("distance"), steps: x.double("steps"),
                                  imageURL: x.str("image_url") ?? x.str("avatar_url"), userId: people ? x.int("id") : nil) }
        }
        return Leaderboard(teams: rows(r.arr("teams"), people: false), users: rows(r.arr("users"), people: true))
    }

    // Activity
    func myActivities(offset: Int, limit: Int = 30) async throws -> ([MyActivity], Bool) {
        let r = try await request("/api/me/activities?limit=\(limit)&offset=\(offset)")
        let list = r.arr("activities").map { a in
            MyActivity(id: a.int("id"), challengeId: a.int("challenge_id"), challengeName: a.string("challenge_name"), teamName: a.str("team_name"),
                       type: a.string("activity_type"), minutes: a.doubleOrNil("minutes"), distance: a.doubleOrNil("distance"), steps: a.intOrNil("steps"),
                       distanceUnit: unit(a), measure: Measure(a.str("metric")), date: a.day("activity_date"), startTime: a.str("start_time"),
                       endTime: a.str("end_time"), comment: a.str("comment"), source: a.string("source"), hasRoute: a.bool("has_route"))
        }
        return (list, r.bool("more"))
    }
    func route(activityId: Int) async throws -> [RoutePoint] {
        let r = try await request("/api/activities/\(activityId)/route")
        return (r.o["points"] as? [[Any]] ?? []).compactMap { p in
            guard p.count >= 2, let lat = (p[0] as? NSNumber)?.doubleValue, let lon = (p[1] as? NSNumber)?.doubleValue else { return nil }
            return RoutePoint(lat: lat, lon: lon, timeMs: p.count > 2 ? (p[2] as? NSNumber)?.int64Value : nil, altitude: p.count > 3 ? (p[3] as? NSNumber)?.doubleValue : nil)
        }
    }
    func deleteActivity(_ id: Int) async throws { _ = try await request("/api/activities/\(id)", "DELETE") }
    func editActivity(_ id: Int, type: String, date: Day, minutes: Int?, distance: Double?, unit: String, start: String?, end: String?, comment: String) async throws {
        _ = try await request("/api/activities/\(id)", "PATCH", ["activity_type": type, "activity_date": date.description,
            "minutes": minutes.map(String.init) ?? "", "distance": distance.map { String($0) } ?? "", "distance_unit": unit,
            "start_time": start ?? "", "end_time": end ?? "", "comment": comment])
    }
    func editSteps(_ id: Int, date: Day, steps: Int, comment: String) async throws {
        _ = try await request("/api/activities/\(id)", "PATCH", ["steps": steps, "activity_date": date.description, "comment": comment])
    }
    /// Manual log into one or more challenges at once (all or none). Returns how many entries were made.
    func logActivity(targets: [Target], type: String, date: Day, minutes: Int?, distance: Double?, unit: String, start: String?, end: String?, comment: String, steps: Int?) async throws -> Int {
        var b: [String: Any] = ["targets": targets.map { t -> [String: Any] in var o: [String: Any] = ["challenge_id": t.challengeId]; if let tm = t.teamId { o["team_id"] = tm }; return o },
                                "activity_type": type, "activity_date": date.description, "minutes": minutes.map { $0 as Any } ?? NSNull(), "comment": comment]
        if let distance { b["distance"] = distance; b["distance_unit"] = unit }
        if let steps { b["steps"] = steps }
        if let start, let end, !start.isEmpty, !end.isEmpty { b["start_time"] = start; b["end_time"] = end }
        let r = try await request("/api/activities", "POST", b)
        return r.int("created", targets.count)
    }
    /// Which of these device records are already in which challenges.
    func syncedIn(_ refs: [String]) async throws -> [String: Set<Int>] {
        guard !refs.isEmpty else { return [:] }
        let r = try await request("/api/health/synced", "POST", ["source": "health_kit", "refs": refs])
        guard let o = r.o["syncedIn"] as? [String: Any] else { return [:] }
        return o.mapValues { Set(($0 as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.intValue }) }
    }
    func importHealth(_ records: [HealthRecord]) async throws -> ImportResult {
        let payload: [String: Any] = ["source": "health_kit", "records": records.map { r -> [String: Any] in
            var o: [String: Any] = ["challenge_id": r.target.challengeId, "activity_type": r.activityType, "minutes": r.minutes, "activity_date": r.activityDate,
                                    "source_ref": r.sourceRef, "start_time": r.startTime, "end_time": r.endTime]
            if let t = r.target.teamId { o["team_id"] = t }
            if let d = r.distanceMeters { o["distance_m"] = d }
            if let pts = r.route { o["route"] = pts.map { p -> [Any] in [p.lat, p.lon, p.timeMs.map { $0 as Any } ?? NSNull(), p.altitude.map { $0 as Any } ?? NSNull()] } }
            return o
        }]
        let r = try await request("/api/health/import", "POST", payload)
        return ImportResult(added: r.int("added"), skipped: r.int("skipped"), updated: r.int("updated"))
    }
    /// Daily step totals; the server adds new days and updates days already sent.
    func importSteps(_ days: [StepDay]) async throws -> ImportResult {
        guard !days.isEmpty else { return ImportResult(added: 0, skipped: 0, updated: 0) }
        let payload: [String: Any] = ["source": "health_kit", "records": days.map { d -> [String: Any] in
            var o: [String: Any] = ["challenge_id": d.target.challengeId, "activity_type": "Steps", "steps": d.steps, "activity_date": d.date.description, "source_ref": "steps:\(d.date)"]
            if let t = d.target.teamId { o["team_id"] = t }
            return o
        }]
        let r = try await request("/api/health/import", "POST", payload)
        return ImportResult(added: r.int("added"), skipped: r.int("skipped"), updated: r.int("updated"))
    }

    // Profiles
    func profile(_ userId: Int) async throws -> Profile {
        let r = try await request("/api/users/\(userId)/profile")
        let challenges: [ProfileChallenge]? = r.has("challenges") ? r.arr("challenges").map { c in
            ProfileChallenge(id: c.int("id"), name: c.string("name"), startDate: c.day("start_date"), endDate: c.day("end_date"), measure: Measure(c.str("metric")),
                             distanceUnit: unit(c), team: c.str("team"), minutes: c.double("minutes"), distance: c.double("distance"), steps: c.double("steps"),
                             rank: c.int("rank"), of: c.int("of"))
        } : nil
        let activities: [ProfileActivity]? = r.has("activities") ? r.arr("activities").map { x in
            ProfileActivity(type: x.string("activity_type"), minutes: x.doubleOrNil("minutes"), distance: x.doubleOrNil("distance"), steps: x.intOrNil("steps"),
                            distanceUnit: unit(x), measure: Measure(x.str("metric")), date: x.day("activity_date"), startTime: x.str("start_time"),
                            comment: x.str("comment"), challengeName: x.string("challenge_name"))
        } : nil
        return Profile(id: r.int("id"), name: r.string("name"), avatarURL: r.str("avatar_url"), bio: r.str("bio"), memberSince: r.string("member_since"),
                       sharing: r.str("sharing") ?? "summary", isSelf: r.bool("self"), challenges: challenges, activities: activities)
    }
    func updateProfile(name: String? = nil, email: String? = nil, currentPassword: String? = nil, newPassword: String? = nil,
                       avatarURL: String? = nil, bio: String? = nil, sharing: String? = nil) async throws -> Me {
        var b: [String: Any] = [:]
        if let name { b["name"] = name }
        if let email { b["email"] = email }
        if let currentPassword, !currentPassword.isEmpty { b["currentPassword"] = currentPassword }
        if let newPassword, !newPassword.isEmpty { b["newPassword"] = newPassword }
        if let avatarURL { b["avatarUrl"] = avatarURL }
        if let bio { b["bio"] = bio }
        if let sharing { b["profileSharing"] = sharing }
        return parseMe(try await request("/api/me", "PATCH", b).obj("user") ?? J([:]))
    }
    /// Upload an image as a data: URL; returns its /uploads/... path.
    func uploadImage(dataURL: String) async throws -> String { try await request("/api/uploads", "POST", ["dataUrl": dataURL]).string("url") }

    // Help & support
    private func parseTicket(_ t: J) -> Ticket {
        let rep = t.obj("reporter")
        return Ticket(id: t.int("id"), type: t.string("type"), title: t.string("title"), description: t.string("description"), status: t.string("status"),
                      resolution: t.str("resolution"), imageURL: t.str("image_url"), clientInfo: t.str("client_info"), createdAt: t.string("created_at"),
                      updatedAt: t.string("updated_at"), reporterName: rep?.string("name") ?? "", reporterEmail: rep?.str("email"),
                      commentCount: t.int("comment_count"), unread: t.bool("unread"), mine: t.bool("mine"))
    }
    func tickets(all: Bool = false, status: String? = nil, type: String? = nil) async throws -> TicketList {
        var q: [String] = []
        if all { q.append("scope=all") }
        if let status { q.append("status=\(status)") }
        if let type { q.append("type=\(type)") }
        let r = try await request("/api/tickets" + (q.isEmpty ? "" : "?" + q.joined(separator: "&")))
        func counts(_ k: String) -> [String: Int] { (r.o[k] as? [String: Any] ?? [:]).compactMapValues { ($0 as? NSNumber)?.intValue } }
        return TicketList(tickets: r.arr("tickets").map(parseTicket), counts: counts("counts"), openByType: counts("byType"))
    }
    func ticket(_ id: Int) async throws -> (Ticket, [TicketComment]) {
        let r = try await request("/api/tickets/\(id)")
        return (parseTicket(r), r.arr("comments").map { c in
            TicketComment(id: c.int("id"), body: c.string("body"), internalNote: c.bool("internal"), createdAt: c.string("created_at"),
                          authorName: c.obj("author")?.string("name") ?? "", fromSupport: c.bool("from_support"))
        })
    }
    func createTicket(type: String, title: String, description: String, imageURL: String?, clientInfo: String) async throws -> Int {
        var b: [String: Any] = ["type": type, "title": title, "description": description, "client_info": clientInfo]
        if let imageURL { b["image_url"] = imageURL }
        return try await request("/api/tickets", "POST", b).int("id")
    }
    func replyTicket(_ id: Int, body: String, internalNote: Bool) async throws { _ = try await request("/api/tickets/\(id)/comments", "POST", ["body": body, "internal": internalNote]) }
    func updateTicket(_ id: Int, status: String, resolution: String) async throws { _ = try await request("/api/tickets/\(id)", "PATCH", ["status": status, "resolution": resolution]) }
    /// Unread replies on my tickets, and (admins) tickets waiting for support.
    func ticketBadge() async throws -> (Int, Int) { let r = try await request("/api/tickets/badge"); return (r.int("mine"), r.int("admin")) }

    // App updates
    func iosRelease() async throws -> AppRelease? {
        let r = try await request("/api/app/ios")
        return r.bool("available") ? AppRelease(version: r.string("version"), build: r.int("build")) : nil
    }

    // Global admins
    func adminUsers() async throws -> [AdminUser] {
        try await request("/api/admin/users").arr("users").map { u in
            AdminUser(id: u.int("id"), name: u.string("name"), email: u.string("email"), role: u.str("role") ?? "member", avatarURL: u.str("avatar_url"),
                      createdAt: String(u.string("created_at").prefix(10)), challenges: u.int("challenges"), activities: u.int("activities"),
                      lastActivity: u.str("last_activity"), tickets: u.int("tickets"), deactivatedAt: u.str("deactivated_at").map { String($0.prefix(10)) })
        }
    }
    func adminChallenges() async throws -> [AdminChallenge] {
        try await request("/api/admin/challenges").arr("challenges").map { c in
            AdminChallenge(id: c.int("id"), name: c.string("name"), startDate: c.day("start_date"), endDate: c.day("end_date"), measure: Measure(c.str("metric")),
                           distanceUnit: unit(c), individual: c.str("participation") == "individual", inviteCode: c.string("invite_code"),
                           owners: c.str("owners") ?? c.str("creator_name"), members: c.int("members"), teams: c.int("teams"), activities: c.int("activities"),
                           state: c.string("state"), purgeDate: c.string("purge_date"))
        }
    }
    func adminUpdateUser(_ id: Int, name: String, email: String, role: String, password: String) async throws {
        var b: [String: Any] = ["name": name, "email": email, "role": role]
        if !password.isEmpty { b["password"] = password }
        _ = try await request("/api/admin/users/\(id)", "PATCH", b)
    }
    func adminCreateUser(name: String, email: String, role: String, password: String) async throws {
        _ = try await request("/api/admin/users", "POST", ["name": name, "email": email, "role": role, "password": password])
    }
    func adminSetActive(_ id: Int, active: Bool) async throws { _ = try await request("/api/admin/users/\(id)", "PATCH", ["active": active]) }
    func adminDeleteUser(_ id: Int) async throws { _ = try await request("/api/admin/users/\(id)", "DELETE") }

    // Transport
    private func request(_ path: String, _ method: String = "GET", _ body: [String: Any]? = nil) async throws -> J {
        guard let url = URL(string: base + path) else { throw APIError(status: 0, message: "Bad address") }
        var req = URLRequest(url: url, timeoutInterval: 60)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200...299).contains(status) else {
            throw APIError(status: status, message: (json["error"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Request failed with HTTP \(status)")
        }
        return J(json)
    }
}
