import SwiftUI

private func myTotal(_ c: Challenge) -> String { fmtMeasure(c.measure, minutes: c.myMinutes, distance: c.myDistance, steps: c.mySteps, unit: c.distanceUnit) }
private func measureIcon(_ m: Measure) -> String { switch m { case .steps: "shoeprints.fill"; case .distance: "ruler"; case .minutes: "timer" } }

struct ChallengesView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router

    var body: some View {
        Page(refresh: { await model.refreshTop() }) {
            let active = model.challenges.filter(\.isActive).count
            Hero(Date().formatted(.dateTime.weekday(.wide).day().month(.wide)), "Hi \(model.me?.name.components(separatedBy: " ").first ?? "")") {
                Text("\(active) active challenge\(active == 1 ? "" : "s")").foregroundStyle(.white.opacity(0.9))
            }
            if model.update != nil { UpdateBanner() }
            HStack(spacing: 8) {
                Button { router.push(.newChallenge) } label: { Label("New challenge", systemImage: "plus").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
                Button { router.push(.join) } label: { Label("Join with code", systemImage: "person.badge.plus").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
            }.controlSize(.large)
            if model.challenges.isEmpty && !model.loadingChallenges {
                SectionCard { EmptyNote("You're not in a challenge yet. Start one, or join with an invite code someone shared with you.") }
            }
            ForEach(model.challenges.sorted { ($0.isActive ? 0 : 1, $1.startDate) < ($1.isActive ? 0 : 1, $0.startDate) }) { c in
                Button { router.push(.challenge(c.id)) } label: { ChallengeCard(c: c) }.buttonStyle(.plain)
            }
        }
        .navigationTitle("Active Together").navigationBarTitleDisplayMode(.inline)
    }
}

private struct ChallengeCard: View {
    let c: Challenge
    var body: some View {
        SectionCard {
            HStack {
                VStack(alignment: .leading) {
                    Text(c.name).font(.title3.bold()).foregroundStyle(.primary)
                    Text(fmtRange(c.startDate, c.endDate)).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing) {
                    Text(myTotal(c)).font(.title3.bold()).foregroundStyle(Color.brandRed)
                    Text("logged by me").font(.caption).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Pill(text: measureLabel(c.measure, unit: c.distanceUnit), background: Color(.tertiarySystemFill), foreground: .primary)
                Pill(text: c.individual ? "Individual" : c.myTeams.first?.name ?? "No team yet", background: Color(.tertiarySystemFill), foreground: .primary)
                Pill(text: stateLabel(c.startDate, c.endDate), background: c.isActive ? Color.brandYellow.opacity(0.35) : Color(.tertiarySystemFill), foreground: .primary)
            }
        }
    }
}

struct ChallengeDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    let challengeId: Int
    @State private var tab = 0
    @State private var newTeam = ""
    @State private var leavingTeam: TeamInfo?
    @State private var leavingChallenge = false

    var body: some View {
        // A global admin can open a challenge they haven't joined; it's not on their dashboard, so it comes from the full record.
        if let c = model.challenges.first(where: { $0.id == challengeId }) ?? model.details[challengeId]?.asChallenge {
            content(c)
        } else {
            ProgressView().task { await model.loadDetail(challengeId) }
        }
    }

    private func content(_ c: Challenge) -> some View {
        let board = model.leaderboards[challengeId], detail = model.details[challengeId]
        return Page(refresh: { await model.refreshChallenge(challengeId) }) {
            Hero(eyebrow: "\(fmtRange(c.startDate, c.endDate)) · \(stateLabel(c.startDate, c.endDate))", title: c.name, trailing: {
                HeroStat(value: c.measuresSteps ? fmtSteps(c.mySteps) : c.measuresDistance ? fmtNum(c.myDistance) : fmtNum(c.myMinutes),
                         label: c.measuresSteps ? "my steps" : c.measuresDistance ? "my \(unitLong(c.distanceUnit))" : "my minutes")
            }, below: {
                Text([measureLabel(c.measure, unit: c.distanceUnit), c.individual ? "Individuals" : c.myTeams.map(\.name).joined(separator: ", "), "Role: \(c.role)"]
                    .filter { !$0.isEmpty }.joined(separator: " · ")).font(.subheadline).foregroundStyle(.white.opacity(0.9))
            })
            if !c.descriptionHTML.isEmpty { SectionCard("About") { Text(htmlToText(c.descriptionHTML)).font(.body) } }
            if let d = detail {
                SectionCard(title: "Invite people", action: {
                    if d.canManage { Button { router.push(.editChallenge(c.id)) } label: { Label("Edit", systemImage: "pencil") } }
                }, content: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text("Invite code").font(.caption).foregroundStyle(.secondary)
                            Text(d.inviteCode).font(.title2.bold()).textSelection(.enabled)
                        }
                        Spacer()
                        ShareLink(item: URL(string: "\(serverURL)/join/\(d.inviteCode)")!,
                                  message: Text("Join my challenge \"\(d.name)\" on Active Together (or use invite code \(d.inviteCode))")) { Label("Share", systemImage: "square.and.arrow.up") }
                            .buttonStyle(.bordered)
                    }
                })
                if !c.individual { teams(c, d) }
            }
            SectionCard("Leaderboard") {
                if !c.individual {
                    Picker("", selection: $tab) { Text("Teams").tag(0); Text("Individuals").tag(1) }.pickerStyle(.segmented)
                }
                if let board {
                    let rows = (tab == 0 && !c.individual) ? board.teams : board.users
                    if rows.isEmpty { EmptyNote("Nobody on the board yet.") }
                    if !(tab == 0 && !c.individual) { Text("Tap someone to see their profile.").font(.caption).foregroundStyle(.secondary) }
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, s in
                        Button { if let uid = s.userId { router.push(.user(uid)) } } label: {
                            HStack {
                                Text("\(i + 1)").font(.headline.weight(.black)).foregroundStyle(i < 3 ? Color.brandRed : .secondary).frame(width: 28, alignment: .leading)
                                Avatar(url: s.imageURL, name: s.name)
                                Text(s.name).font(.headline).foregroundStyle(.primary)
                                Spacer()
                                Text(fmtMeasure(c.measure, minutes: s.minutes, distance: s.distance, steps: s.steps, unit: c.distanceUnit)).font(.headline).foregroundStyle(.primary)
                                if s.userId != nil { Image(systemName: "chevron.right").foregroundStyle(.secondary) }
                            }.padding(.vertical, 4)
                        }.buttonStyle(.plain).disabled(s.userId == nil)
                        if i < rows.count - 1 { Divider() }
                    }
                } else { ProgressView().frame(maxWidth: .infinity) }
            }
            if let d = detail, d.role != "admin" {
                Button(role: .destructive) { leavingChallenge = true } label: {
                    Label("Leave challenge", systemImage: "rectangle.portrait.and.arrow.right").frame(maxWidth: .infinity)
                }.buttonStyle(.bordered).controlSize(.large)
            }
        }
        .navigationTitle("Challenge").navigationBarTitleDisplayMode(.inline)
        .task(id: challengeId) { await model.loadLeaderboard(challengeId); await model.loadDetail(challengeId) }
        .alert("Leave \(leavingTeam?.name ?? "the team")?", isPresented: Binding(get: { leavingTeam != nil }, set: { if !$0 { leavingTeam = nil } }), presenting: leavingTeam) { t in
            Button("Leave team", role: .destructive) { Task { await model.leaveTeam(c.id, t.id) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("What you've logged under this team stays on its total. You stay in the challenge.") }
        .alert("Leave \(c.name)?", isPresented: $leavingChallenge) {
            Button("Leave challenge", role: .destructive) { Task { if await model.leaveChallenge(c.id) { router.popToRoot() } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Everything you've logged in it is deleted, and you'll need an invite to join again.") }
    }

    private func teams(_ c: Challenge, _ d: ChallengeDetail) -> some View {
        SectionCard("Teams") {
            if c.myTeams.isEmpty { Text("You're not in a team yet. Join one or start your own to log activity here.").foregroundStyle(Color.brandRed) }
            if d.teams.isEmpty { EmptyNote("No teams yet - create the first one.") }
            ForEach(d.teams) { t in
                HStack {
                    Avatar(url: t.imageURL, name: t.name)
                    VStack(alignment: .leading) {
                        Text(t.name).font(.headline)
                        Text(["\(t.members) member\(t.members == 1 ? "" : "s")", t.mine ? "your team" : nil, t.inviteCode.map { "code \($0)" }].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if !t.mine && d.role != "admin" { Button("Join") { Task { await model.joinTeam(c.id, t.id) } } }
                    if t.mine { Button("Leave") { leavingTeam = t }.foregroundStyle(.secondary) }
                }
            }
            if d.role != "admin" {
                HStack {
                    TextField("New team name", text: $newTeam).textFieldStyle(.roundedBorder)
                    Button("Create") { Task { if await model.createTeam(c.id, newTeam) { newTeam = "" } } }.buttonStyle(.borderedProminent)
                        .disabled(newTeam.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

/// Plain text from the form as the simple HTML the web editor stores: one paragraph per line.
private func textToHTML(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .newlines).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        .map { "<p>" + $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") + "</p>" }
        .joined()
}

/// New challenge (challengeId nil) or edit one I own; editing can also delete it.
struct ChallengeFormView: View {
    @Environment(AppModel.self) private var model
    let challengeId: Int?
    var body: some View {
        if let id = challengeId {
            if let d = model.details[id] { ChallengeForm(existing: d) } else { ProgressView().task { await model.loadDetail(id) } }
        } else { ChallengeForm(existing: nil) }
    }
}

private struct ChallengeForm: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    let existing: ChallengeDetail?
    @State private var name = ""
    @State private var description = ""
    @State private var originalDescription = ""
    @State private var start = Date()
    @State private var end = Calendar.current.date(byAdding: .day, value: 29, to: Date())!
    @State private var measure = Measure.minutes
    @State private var unit = Prefs.preferredUnit
    @State private var individual = false
    @State private var firstTeam = ""
    @State private var busy = false
    @State private var error: String?
    @State private var deleting = false
    @State private var typedName = ""
    @State private var loaded = false

    var body: some View {
        Form {
            Section(existing == nil ? "New challenge" : "Challenge") {
                TextField("Name", text: $name)
                TextField("Description (optional)", text: $description, axis: .vertical).lineLimit(3...8)
                if let e = existing, e.descriptionHTML.range(of: "<(b|i|strong|em|ul|ol|a)\\b", options: .regularExpression) != nil {
                    Text("Editing here replaces any bold, lists or links set on the website.").font(.caption).foregroundStyle(.secondary)
                }
                DatePicker("Starts", selection: $start, displayedComponents: .date)
                DatePicker("Ends", selection: $end, in: start..., displayedComponents: .date)
            }
            Section("How it works") {
                Picker("Measure", selection: $measure) { ForEach(Measure.allCases) { Text($0.label).tag($0) } }
                if measure == .distance { Picker("Distance unit", selection: $unit) { Text("Miles").tag("mi"); Text("Kilometres").tag("km") } }
                if measure == .steps { Text("Everyone's daily step total counts. The app fills it in from Apple Health, or people enter it by hand.").font(.caption).foregroundStyle(.secondary) }
                Picker("Who takes part", selection: $individual) { Text("Teams").tag(false); Text("Individuals only").tag(true) }
                Text(individual ? "Everyone logs straight to the challenge; there are no teams." : "People join a team and the teams compete, as well as individuals.")
                    .font(.caption).foregroundStyle(.secondary)
                if let e = existing, e.measure != measure {
                    Text("Changing the measure re-ranks the leaderboards. Entries logged without that measure count as zero toward it.").font(.caption).foregroundStyle(.red)
                }
                if existing == nil && !individual {
                    TextField("Your team's name (optional)", text: $firstTeam)
                    Text("Creates the first team with you in it. Others can create their own.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Section {
                Button(busy ? "Saving..." : existing == nil ? "Create challenge" : "Save changes") { save() }.disabled(busy).bold()
            }
            if existing != nil {
                Section("Delete challenge") {
                    Text("Permanently deletes this challenge with all its teams, members and logged activity, for everyone. This can't be undone.").font(.subheadline)
                    Button("Delete challenge", role: .destructive) { typedName = ""; deleting = true }
                }
            }
        }
        .navigationTitle(existing == nil ? "New challenge" : "Edit challenge").navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: load)
        .alert("Delete \"\(existing?.name ?? "")\"?", isPresented: $deleting) {
            TextField("Challenge name", text: $typedName)
            Button("Delete", role: .destructive) {
                guard let e = existing, typedName.trimmingCharacters(in: .whitespaces) == e.name.trimmingCharacters(in: .whitespaces) else { model.message = "The name didn't match, so nothing was deleted."; return }
                Task { if await model.deleteChallenge(e.id) { router.popToRoot() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Everything logged in it is deleted for every member. Type the challenge name to confirm.") }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        if let e = existing {
            name = e.name; originalDescription = htmlToText(e.descriptionHTML); description = originalDescription
            start = e.startDate.date; end = e.endDate.date; measure = e.measure; unit = e.distanceUnit; individual = e.individual
        }
    }

    private func save() {
        let s = Day(start), e = Day(end)
        if name.trimmingCharacters(in: .whitespaces).isEmpty { error = "Give the challenge a name."; return }
        if e < s { error = "The end date is before the start date."; return }
        error = nil
        // The web editor allows formatting; only replace the description when it was actually edited here.
        let desc: String? = existing == nil ? (textToHTML(description).isEmpty ? nil : textToHTML(description))
            : (description.trimmingCharacters(in: .whitespacesAndNewlines) != originalDescription ? textToHTML(description) : nil)
        let f = ChallengeFields(name: name.trimmingCharacters(in: .whitespaces), description: desc, startDate: s, endDate: e, measure: measure, distanceUnit: unit, individual: individual)
        busy = true
        Task {
            if let ex = existing {
                if await model.updateChallenge(ex.id, f) { router.pop() }
            } else if let id = await model.createChallenge(f, firstTeam: firstTeam) {
                router.popToRoot(); router.push(.challenge(id))
            }
            busy = false
        }
    }
}

/// Join a challenge (or a team in one) with the code someone shared.
struct JoinView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var code = ""
    @State private var busy = false
    var body: some View {
        Form {
            Section(footer: Text("Enter the code from a challenge or team invite. A team code also puts you in that team.")) {
                TextField("Invite code", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .onChange(of: code) { _, v in let f = v.uppercased().filter { $0.isLetter || $0.isNumber }; if f != v { code = f } }
            }
            Button(busy ? "Joining..." : "Join") {
                busy = true
                Task { if let id = await model.join(code) { router.popToRoot(); router.push(.challenge(id)) }; busy = false }
            }.disabled(code.count < 4 || busy).bold()
        }
        .navigationTitle("Join a challenge")
    }
}

private func inviteTitle(_ p: InvitePreview) -> String { p.isTeam ? "\(p.teamName ?? "") in \(p.challengeName)" : p.challengeName }
private func inviteDetail(_ p: InvitePreview) -> String {
    let what: String = switch p.measure { case .steps: "counts steps"; case .distance: "measures distance (\(unitLong(p.distanceUnit)))"; case .minutes: "measures active minutes" }
    return [fmtRange(p.startDate, p.endDate), what, p.individual ? "individuals" : "teams", "\(p.members) member\(p.members == 1 ? "" : "s")"].joined(separator: " · ")
}

/// An invite link, opened while signed in: say what it's for and ask before joining.
struct InviteView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    let code: String
    @State private var preview: InvitePreview?
    @State private var failed: String?
    @State private var busy = false

    var body: some View {
        Page {
            if let failed {
                SectionCard("Invite link") {
                    Text(failed).foregroundStyle(.red)
                    Text("Ask whoever sent it for a new link or code.")
                    Button("OK") { router.popToRoot() }.buttonStyle(.bordered)
                }
            } else if let p = preview {
                Hero(p.alreadyIn ? "You're already in" : "You're invited", inviteTitle(p))
                SectionCard {
                    Text(inviteDetail(p))
                    if p.isTeam && p.member == true && p.inTeam != true { Text("You're already in the challenge; this adds you to the team.").font(.caption) }
                    if p.alreadyIn {
                        Button { router.popToRoot(); router.push(.challenge(p.challengeId)) } label: { Text("Open the challenge").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
                    } else {
                        Button {
                            busy = true
                            Task { if let id = await model.join(code) { router.popToRoot(); router.push(.challenge(id)) }; busy = false }
                        } label: { Text(busy ? "Joining..." : p.isTeam ? "Join the team" : "Join the challenge").frame(maxWidth: .infinity) }
                            .buttonStyle(.borderedProminent).disabled(busy)
                        Button("Not now") { router.popToRoot() }.frame(maxWidth: .infinity)
                    }
                }
            } else { ProgressView().frame(maxWidth: .infinity) }
        }
        .navigationTitle("Invitation").navigationBarTitleDisplayMode(.inline)
        .task(id: code) {
            model.clearInvite()
            do { preview = try await model.api.invitePreview(code) } catch { failed = error.localizedDescription }
        }
    }
}

/// On the sign-in screen when an invite link brought them here.
struct InviteSignInCard: View {
    let code: String
    @State private var preview: InvitePreview?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("You're invited").font(.headline)
            Text(preview.map { "Join \(inviteTitle($0))." } ?? "Sign in to see the invite.")
            Text("Sign in below and we'll ask you to confirm. New to Active Together? Create an account on the website first, then come back and sign in.").font(.caption)
            Link("Create an account", destination: URL(string: "\(serverURL)/?code=\(code)")!).font(.subheadline.bold()).foregroundStyle(Color.brandRed)
        }
        .foregroundStyle(.black).padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.brandYellow, in: RoundedRectangle(cornerRadius: 20))
        .task(id: code) { preview = try? await API(token: nil).invitePreview(code) }
    }
}

/// "Update available": a sideloaded iPhone app can't update itself, so this says what to do.
struct UpdateBanner: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if let u = model.update {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "arrow.down.app").font(.title2)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Update available").font(.headline)
                    Text("Version \(u.version) (you have \(appVersion)). Download it from the website on your computer and install it with Sideloadly, as before.").font(.caption)
                    Link("Open the website", destination: URL(string: serverURL)!).font(.caption.bold())
                }
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.brandYellow.opacity(0.3), in: RoundedRectangle(cornerRadius: 20))
        }
    }
}
