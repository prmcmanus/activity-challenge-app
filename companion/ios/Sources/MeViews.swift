import SwiftUI
import PhotosUI

let sharingLevels: [(code: String, label: String, detail: String)] = [
    ("private", "Private", "Name and photo only"),
    ("summary", "Totals", "Plus my total and rank in each challenge we share"),
    ("full", "Full", "Plus my recent activity in challenges we share"),
]
func sharingLabel(_ code: String) -> String { sharingLevels.first { $0.code == code }?.label ?? "Totals" }

/// A profile: the header, then whatever the person's sharing level shows. Used for anyone, including me.
struct ProfileSections<Header: View>: View {
    let p: Profile
    @ViewBuilder var header: Header
    var body: some View {
        let since: String = Day(p.memberSince).map { "Member since \($0.date.formatted(.dateTime.month(.wide).year()))" } ?? "Profile"
        Hero(eyebrow: since, title: p.name, trailing: { Avatar(url: p.avatarURL, name: p.name, size: 72) }, below: {
            if let bio = p.bio { Text(bio).foregroundStyle(.white.opacity(0.92)) }
        })
        header
        if let challenges = p.challenges {
            SectionCard(p.isSelf ? "My challenges" : "Challenges you share") {
                if challenges.isEmpty { EmptyNote("No challenges yet.") }
                ForEach(challenges, id: \.self) { c in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(c.name).font(.headline)
                            Text([c.team, fmtRange(c.startDate, c.endDate)].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing) {
                            Text(fmtMeasure(c.measure, minutes: c.minutes, distance: c.distance, steps: c.steps, unit: c.distanceUnit)).font(.headline).foregroundStyle(Color.brandRed)
                            if c.rank > 0 { Text("\(ordinal(c.rank)) of \(c.of)").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            if let acts = p.activities {
                SectionCard("Recent activity") {
                    if acts.isEmpty { EmptyNote("Nothing logged yet.") }
                    ForEach(acts, id: \.self) { a in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(a.type).font(.headline)
                                Text([fmtDay(a.date), a.startTime, a.challengeName].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                                if let c = a.comment { Text("“\(c)”").font(.caption) }
                            }
                            Spacer()
                            Text(fmtEntry(minutes: a.minutes, distance: a.distance, steps: a.steps, unit: a.distanceUnit, measure: a.measure)).bold()
                        }
                    }
                }
            }
        } else {
            SectionCard {
                Label(p.isSelf ? "Your profile is private: people only see your name and photo." : "\(p.name.components(separatedBy: " ").first ?? p.name) keeps their profile private.",
                      systemImage: "lock").foregroundStyle(.secondary)
            }
        }
    }
}

/// Someone else's profile (or mine), opened from a leaderboard.
struct UserProfileView: View {
    @Environment(AppModel.self) private var model
    let userId: Int
    @State private var profile: Profile?
    @State private var missing = false
    var body: some View {
        Page(refresh: load) {
            if let p = profile { ProfileSections(p: p) { EmptyView() } }
            else if missing { SectionCard { EmptyNote("This profile isn't available.") } }
            else { ProgressView().frame(maxWidth: .infinity) }
        }
        .navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
        .task(id: userId) { await load() }
    }
    private func load() async {
        if let p = await model.call({ try await $0.profile(userId) }) { profile = p } else { missing = profile == nil }
    }
}

/// Me: my profile exactly as challenge-mates see it, then settings.
struct MeView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var profile: Profile?

    var body: some View {
        Page(refresh: load) {
            if let p = profile {
                ProfileSections(p: p) {
                    HStack {
                        Label("How people in your challenges see you · sharing: \(sharingLabel(model.me?.sharing ?? "summary"))", systemImage: "eye").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button { router.push(.editProfile) } label: { Label("Edit", systemImage: "pencil") }.buttonStyle(.borderedProminent)
                    }
                }
            } else { ProgressView().frame(maxWidth: .infinity) }
            if model.update != nil { UpdateBanner() }
            SyncSettingsCard()
            if model.me?.isAdmin == true {
                Button { router.push(.admin) } label: { Label("Admin: users and challenges", systemImage: "person.badge.key").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
            }
            Button { router.push(.help) } label: {
                Label("Help & feedback" + (model.helpBadge > 0 ? " (\(model.helpBadge) new)" : ""), systemImage: "questionmark.circle").frame(maxWidth: .infinity)
            }.buttonStyle(.bordered).controlSize(.large)
            Button(role: .destructive) { Task { await model.signOut() } } label: { Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).controlSize(.large)
            Text("Active Together · \(serverURL.replacingOccurrences(of: "https://", with: "")) · version \(appVersion)").font(.caption).foregroundStyle(.secondary)
        }
        .navigationTitle("Active Together").navigationBarTitleDisplayMode(.inline)
        .task(id: model.me) { await load() }
    }

    private func load() async {
        guard let m = model.me else { return }
        if let p = await model.call({ try await $0.profile(m.id) }) { profile = p }
    }
}

/// Automatic sync, routes and typing unit.
struct SyncSettingsCard: View {
    @Environment(AppModel.self) private var model
    @State private var autoSync = Prefs.autoSync
    @State private var routes = Prefs.includeRoutes
    @State private var unit = Prefs.preferredUnit

    var body: some View {
        SectionCard("Sync settings") {
            Toggle(isOn: $autoSync) {
                VStack(alignment: .leading) {
                    Text("Sync automatically").font(.headline)
                    Text("New workouts and steps sync when you open the app, and in the background when iOS allows (it chooses when, and only while the phone is unlocked). Workouts with no distance skip distance challenges.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .onChange(of: autoSync) { _, on in model.setAutoSync(on); if on { Task { await model.autoSyncNow() } } }
            Toggle(isOn: $routes) {
                VStack(alignment: .leading) {
                    Text("Include GPS routes").font(.headline)
                    Text("Upload each workout's route so you can see it on a map. Only you can see your routes.").font(.caption).foregroundStyle(.secondary)
                }
            }
            .onChange(of: routes) { _, on in
                Prefs.includeRoutes = on
                // Apple Health asks for routes as their own permission, once.
                if on { Task { try? await model.health.requestAccess(withRoutes: true) } }
            }
            Picker("Distance unit I type in", selection: $unit) { Text("Miles").tag("mi"); Text("Kilometres").tag("km") }
                .onChange(of: unit) { _, u in Prefs.preferredUnit = u }
        }
    }
}

/// Edit my profile: photo, name, bio, sharing level, email and password.
struct EditProfileView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var name = ""
    @State private var bio = ""
    @State private var sharing = "summary"
    @State private var email = ""
    @State private var newPassword = ""
    @State private var currentPassword = ""
    @State private var busy = false
    @State private var note: String?
    @State private var photo: PhotosPickerItem?
    @State private var photoBusy = false
    @State private var loaded = false

    private var sensitive: Bool { !newPassword.isEmpty || (model.me.map { email.trimmingCharacters(in: .whitespaces).lowercased() != $0.email.lowercased() } ?? false) }

    var body: some View {
        Form {
            Section("Photo") {
                HStack {
                    ZStack { Avatar(url: model.me?.avatarURL, name: model.me?.name ?? "?", size: 72); if photoBusy { ProgressView() } }
                    PhotosPicker(selection: $photo, matching: .images) { Label("Change photo", systemImage: "camera") }
                }
            }
            Section("About you") {
                TextField("Name", text: $name)
                TextField("About me (optional)", text: $bio, axis: .vertical).lineLimit(2...5)
                    .onChange(of: bio) { _, v in if v.count > 280 { bio = String(v.prefix(280)) } }
                Text("\(bio.count)/280").font(.caption).foregroundStyle(.secondary)
            }
            Section(header: Text("Who sees what"), footer: Text("Only people in a challenge with you can open your profile, and only for challenges you share. Leaderboard totals are always visible to them; GPS routes never are.")) {
                Picker("Sharing", selection: $sharing) {
                    ForEach(sharingLevels, id: \.code) { l in VStack(alignment: .leading) { Text(l.label); Text(l.detail).font(.caption) }.tag(l.code) }
                }.pickerStyle(.inline).labelsHidden()
            }
            Section("Sign-in details") {
                TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("New password (leave blank to keep)", text: $newPassword)
                if sensitive { SecureField("Current password (needed to change email or password)", text: $currentPassword) }
            }
            if let note { Text(note).foregroundStyle(.red) }
            Button("Save") { save() }.bold()
                .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || email.isEmpty || (sensitive && currentPassword.isEmpty))
        }
        .navigationTitle("Edit profile").navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !loaded, let me = model.me else { return }
            loaded = true; name = me.name; bio = me.bio ?? ""; sharing = me.sharing; email = me.email
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            photoBusy = true
            Task {
                defer { photoBusy = false }
                guard let data = try? await item.loadTransferable(type: Data.self), let url = jpegDataURL(data, maxSide: 320) else { model.message = "Couldn't read that image"; return }
                guard let path = await model.call({ try await $0.uploadImage(dataURL: url) }) else { return }
                if let m = await model.call({ try await $0.updateProfile(avatarURL: path) }) { model.me = m; model.message = "Photo updated" }
            }
        }
    }

    private func save() {
        busy = true; note = nil
        let me = model.me
        let changedEmail = email.trimmingCharacters(in: .whitespaces)
        Task {
            let updated = await model.call {
                try await $0.updateProfile(name: name.trimmingCharacters(in: .whitespaces), email: changedEmail.lowercased() == me?.email.lowercased() ? nil : changedEmail,
                                           currentPassword: currentPassword, newPassword: newPassword, bio: bio.trimmingCharacters(in: .whitespaces), sharing: sharing)
            }
            busy = false
            if let updated { model.me = updated; Prefs.email = updated.email; model.message = "Profile saved"; router.pop() }
            else { note = model.message; model.message = nil }
        }
    }
}
