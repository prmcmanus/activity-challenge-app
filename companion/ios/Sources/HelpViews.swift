import SwiftUI
import PhotosUI
import UIKit

let ticketTypes = [("bug", "Bug"), ("feature", "Feature request"), ("question", "Question")]
let ticketStatuses = [("new", "New"), ("in_progress", "In progress"), ("planned", "Planned"), ("done", "Done"), ("declined", "Declined")]
func ticketTypeLabel(_ t: String) -> String { ticketTypes.first { $0.0 == t }?.1 ?? t }
func ticketStatusLabel(_ s: String) -> String { ticketStatuses.first { $0.0 == s }?.1 ?? s }

struct StatusPill: View {
    let status: String
    var body: some View {
        let (bg, fg): (Color, Color) = switch status {
        case "new": (Color(red: 1, green: 0.95, blue: 0.77), Color(red: 0.36, green: 0.27, blue: 0))
        case "in_progress": (Color(red: 0.86, green: 0.91, blue: 1), Color(red: 0.04, green: 0.24, blue: 0.57))
        case "planned": (Color(red: 0.91, green: 0.87, blue: 0.99), Color(red: 0.29, green: 0.16, blue: 0.57))
        case "done": (Color(red: 0.85, green: 0.95, blue: 0.87), Color(red: 0.08, green: 0.33, blue: 0.18))
        default: (Color(white: 0.93), Color(white: 0.33))
        }
        Pill(text: ticketStatusLabel(status), background: bg, foreground: fg)
    }
}

private struct TicketRow: View {
    let t: Ticket, showReporter: Bool
    var body: some View {
        HStack {
            Image(systemName: t.type == "bug" ? "ladybug" : t.type == "feature" ? "lightbulb" : "questionmark.bubble").foregroundStyle(Color.brandRed)
            VStack(alignment: .leading) {
                HStack(spacing: 6) {
                    if t.unread { Circle().fill(Color.brandRed).frame(width: 9, height: 9) }
                    Text(t.title).font(.headline).fontWeight(t.unread ? .heavy : .semibold).foregroundStyle(.primary)
                }
                Text(["#\(t.id)", showReporter ? t.reporterName : nil, "updated \(fmtWhen(t.updatedAt))", t.commentCount > 0 ? "\(t.commentCount) repl\(t.commentCount == 1 ? "y" : "ies")" : nil]
                    .compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            StatusPill(status: t.status)
        }.padding(.vertical, 4)
    }
}

private let faq: [(String, String)] = [
    ("How do challenges work?", "A challenge runs between two dates and measures active minutes, distance (miles or km) or steps, in teams or by individuals. Join one with the invite code or link its owner shares."),
    ("How do I log activity?", "Sync it from Apple Health on the Sync tab, or tap + on the Activity tab to log it by hand. One workout counts in every challenge it fits - you choose which. The date must fall within the challenge."),
    ("How do step challenges work?", "Each day's step total from Apple Health goes into every step challenge running that day, topped up as the day goes on. You can also enter a day's steps by hand."),
    ("Why didn't a workout count in my distance challenge?", "It has no recorded distance (yoga or gym sessions, for example). In Sync, type the distance in the review; for an entry already logged, open it and tap Edit activity."),
    ("How does automatic sync work?", "Switch it on under Me. New workouts and steps sync whenever you open the app, and in the background when iOS allows it."),
    ("Who can see my profile and activity?", "Only people in a challenge with you, and only for challenges you share. Choose Private, Totals or Full under Me › Edit. GPS routes are only ever visible to you."),
    ("How long is data kept, and can I delete it?", "A challenge and everything in it is deleted 60 days after it ends, or earlier if its owner deletes it. You can remove any entry you logged. To delete your account, send a ticket."),
]

/// Help: quick answers, a way to report a bug or request a feature, my tickets, and (admins) the dashboard.
struct HelpView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var list: TicketList?

    var body: some View {
        Page(refresh: load) {
            Hero("Help & support", "How can we help?") {
                Text("Quick answers below. Something broken, or an idea? Send a ticket and follow the replies here.").foregroundStyle(.white.opacity(0.92))
            }
            if model.me?.isAdmin == true {
                Button { router.push(.support) } label: { Label("Support dashboard", systemImage: "person.crop.circle.badge.questionmark").frame(maxWidth: .infinity) }.buttonStyle(.bordered).controlSize(.large)
            }
            Button { router.push(.newTicket) } label: { Label("Report a bug or request a feature", systemImage: "ladybug").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).controlSize(.large)
            SectionCard("My tickets") {
                if let l = list {
                    if l.tickets.isEmpty { EmptyNote("You haven't sent any tickets yet.") }
                    ForEach(l.tickets) { t in Button { router.push(.ticket(t.id)) } label: { TicketRow(t: t, showReporter: false) }.buttonStyle(.plain) }
                } else { ProgressView().frame(maxWidth: .infinity) }
            }
            SectionCard("Quick answers") {
                ForEach(faq, id: \.0) { q, a in
                    DisclosureGroup { Text(a).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading) } label: { Text(q).font(.headline).foregroundStyle(.primary) }
                }
            }
        }
        .navigationTitle("Help").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }
    private func load() async {
        if let l = await model.call({ try await $0.tickets() }) { list = l }
        await model.refreshHelpBadge()
    }
}

/// Report a bug, request a feature or ask a question. The phone and app version go along automatically.
struct NewTicketView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var type = "bug"
    @State private var title = ""
    @State private var details = ""
    @State private var photo: PhotosPickerItem?
    @State private var image: Data?
    @State private var busy = false
    private var clientInfo: String { "iOS \(UIDevice.current.systemVersion) · \(UIDevice.current.model) · app \(appVersion)" }

    var body: some View {
        Form {
            Picker("What is it?", selection: $type) { Text("Bug").tag("bug"); Text("Idea").tag("feature"); Text("Question").tag("question") }.pickerStyle(.segmented)
            TextField(type == "bug" ? "Title, e.g. Sync misses my evening walks" : type == "feature" ? "Title, e.g. A weekly summary" : "Title, e.g. How do teams work?", text: $title)
            TextField(type == "bug" ? "What happened, what you expected, and the steps to see it." : "Tell us more.", text: $details, axis: .vertical).lineLimit(5...12)
            HStack {
                PhotosPicker(selection: $photo, matching: .images) { Label(image == nil ? "Add a screenshot" : "Change screenshot", systemImage: "photo.badge.plus") }
                if let image, let ui = UIImage(data: image) { Image(uiImage: ui).resizable().scaledToFill().frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 8)) }
            }
            Text("Sent with it: \(clientInfo)").font(.caption).foregroundStyle(.secondary)
            Button(busy ? "Sending..." : "Send") { send() }.bold().disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty || details.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .navigationTitle("New ticket").navigationBarTitleDisplayMode(.inline)
        .onChange(of: photo) { _, item in Task { image = try? await item?.loadTransferable(type: Data.self) } }
    }

    private func send() {
        busy = true
        Task {
            defer { busy = false }
            var url: String?
            if let image {
                guard let data = jpegDataURL(image, maxSide: 1600) else { model.message = "Couldn't read that image"; return }
                guard let u = await model.call({ try await $0.uploadImage(dataURL: data) }) else { return }
                url = u
            }
            if let id = await model.call({ try await $0.createTicket(type: type, title: title.trimmingCharacters(in: .whitespaces), description: details.trimmingCharacters(in: .whitespaces), imageURL: url, clientInfo: clientInfo) }) {
                model.message = "Thanks - ticket #\(id) sent"
                router.pop(); router.push(.ticket(id))
            }
        }
    }
}

/// One ticket: details, outcome, the conversation and a reply box. Admins also set status and outcome.
struct TicketView: View {
    @Environment(AppModel.self) private var model
    let ticketId: Int
    @State private var data: (Ticket, [TicketComment])?
    @State private var reply = ""
    @State private var internalNote = false
    @State private var busy = false
    @State private var status: String?
    @State private var outcome: String?

    var body: some View {
        let admin = model.me?.isAdmin == true
        Page(refresh: load) {
            if let d = data {
                let t = d.0, comments = d.1
                SectionCard {
                    HStack { StatusPill(status: t.status); Text("\(ticketTypeLabel(t.type)) · #\(t.id) · \(t.mine ? "you" : t.reporterName + (t.reporterEmail.map { " (\($0))" } ?? ""))").font(.caption).foregroundStyle(.secondary)
                        .onTapGesture { if !t.mine && t.reporterId > 0 { model.openProfile(t.reporterId) } } }
                    Text(t.title).font(.title3.bold())
                    Text(t.description)
                    if let u = serverURLFor(t.imageURL) { AsyncImage(url: u) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }.clipShape(RoundedRectangle(cornerRadius: 12)) }
                    if let c = t.clientInfo { Text("Device: \(c)").font(.caption).foregroundStyle(.secondary) }
                    Text("Sent \(fmtWhen(t.createdAt))").font(.caption).foregroundStyle(.secondary)
                }
                if let r = t.resolution {
                    VStack(alignment: .leading, spacing: 4) { Text("Outcome").font(.caption.bold()).foregroundStyle(.green); Text(r) }
                        .padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                }
                if admin {
                    SectionCard("Support") {
                        Picker("Status", selection: Binding(get: { status ?? t.status }, set: { status = $0 })) { ForEach(ticketStatuses, id: \.0) { Text($0.1).tag($0.0) } }
                        TextField("Outcome the reporter sees", text: Binding(get: { outcome ?? "" }, set: { outcome = String($0.prefix(2000)) }), axis: .vertical).textFieldStyle(.roundedBorder)
                        Button("Update status") {
                            busy = true
                            Task { if await model.call({ try await $0.updateTicket(ticketId, status: status ?? t.status, resolution: outcome ?? "") }) != nil { model.message = "Ticket updated" }; busy = false; await load() }
                        }.buttonStyle(.borderedProminent).disabled(busy)
                    }
                }
                Text("Conversation").font(.title3.bold())
                if comments.isEmpty { EmptyNote("No replies yet.") }
                ForEach(comments) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        Text([c.authorName, c.fromSupport ? "Support" : nil, c.internalNote ? "internal note - only admins see this" : nil, fmtWhen(c.createdAt)].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary).onTapGesture { if c.authorId > 0 { model.openProfile(c.authorId) } }
                        Text(c.body)
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(c.internalNote ? Color.brandRed.opacity(0.2) : c.fromSupport ? Color.brandYellow.opacity(0.25) : Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14))
                }
                SectionCard {
                    TextField(admin && !t.mine ? "Reply to the reporter" : "Add a reply", text: $reply, axis: .vertical).lineLimit(3...8).textFieldStyle(.roundedBorder)
                    if admin { Toggle("Internal note (not shown to the reporter)", isOn: $internalNote) }
                    Button {
                        busy = true
                        Task {
                            if await model.call({ try await $0.replyTicket(ticketId, body: reply.trimmingCharacters(in: .whitespacesAndNewlines), internalNote: internalNote) }) != nil { reply = ""; internalNote = false }
                            busy = false; await load()
                        }
                    } label: { Label("Send reply", systemImage: "paperplane") }.buttonStyle(.borderedProminent).disabled(busy || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else { ProgressView().frame(maxWidth: .infinity) }
        }
        .navigationTitle("Ticket").navigationBarTitleDisplayMode(.inline)
        .task(id: ticketId) { await load() }
    }

    private func load() async {
        if let d = await model.call({ try await $0.ticket(ticketId) }) {
            data = d
            if status == nil { status = d.0.status }
            if outcome == nil { outcome = d.0.resolution ?? "" }
        }
        await model.refreshHelpBadge()
    }
}

/// Admins: every ticket, filterable by status and type, with counts.
struct SupportDashboardView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var status: String? = "open"
    @State private var type: String?
    @State private var list: TicketList?

    var body: some View {
        Page(refresh: load) {
            Hero("Admins only", "Support dashboard") {
                if let l = list { Text("Open: \(l.openByType["bug"] ?? 0) bug(s), \(l.openByType["feature"] ?? 0) idea(s), \(l.openByType["question"] ?? 0) question(s)").foregroundStyle(.white.opacity(0.92)) }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    chip("Open", status == "open") { status = "open" }
                    ForEach(ticketStatuses, id: \.0) { code, label in chip("\(label) · \(list?.counts[code] ?? 0)", status == code) { status = code } }
                    chip("All", status == nil) { status = nil }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    chip("All types", type == nil) { type = nil }
                    ForEach(ticketTypes, id: \.0) { code, label in chip(label, type == code) { type = type == code ? nil : code } }
                }
            }
            SectionCard {
                if let l = list {
                    if l.tickets.isEmpty { EmptyNote("No tickets match.") }
                    ForEach(l.tickets) { t in Button { router.push(.ticket(t.id)) } label: { TicketRow(t: t, showReporter: true) }.buttonStyle(.plain) }
                } else { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle("Support dashboard").navigationBarTitleDisplayMode(.inline)
        .task(id: "\(status ?? "")|\(type ?? "")") { await load() }
    }

    private func chip(_ text: String, _ on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(text, action: action).font(.subheadline).padding(.horizontal, 12).padding(.vertical, 6)
            .background(on ? Color.brandRed : Color(.tertiarySystemFill), in: Capsule()).foregroundStyle(on ? .white : .primary)
    }
    private func load() async {
        if let l = await model.call({ try await $0.tickets(all: true, status: status, type: type) }) { list = l }
        await model.refreshHelpBadge()
    }
}
