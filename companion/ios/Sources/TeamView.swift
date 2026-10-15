import SwiftUI

/// A team's own page, opened from its name anywhere: its place and totals, the last fortnight, everyone's share, latest entries.
struct TeamView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    let teamId: Int
    @State private var page: TeamPage?
    @State private var missing = false

    var body: some View {
        Page(refresh: load) {
            if let t = page { content(t) }
            else if missing { SectionCard { EmptyNote("This team isn't available.") } }
            else { ProgressView().frame(maxWidth: .infinity) }
        }
        .navigationTitle("Team").navigationBarTitleDisplayMode(.inline)
        .task(id: teamId) { await load() }
    }

    private func load() async {
        if let p = await model.call({ try await $0.team(teamId) }) { page = p } else { missing = page == nil }
    }

    @ViewBuilder private func content(_ t: TeamPage) -> some View {
        let amount = { (x: Totals) in fmtMeasure(t.measure, minutes: x.minutes, distance: x.distance, steps: x.steps, unit: t.distanceUnit) }
        let inChallenge = model.challenges.contains { $0.id == t.challengeId && $0.role != "admin" }
        let active = t.people.filter { !$0.former }.count
        Hero(eyebrow: t.challengeName, title: t.name, trailing: {
            if t.rank > 0 { HeroStat(value: ordinal(t.rank), label: "of \(t.of) teams") }
        }, below: {
            HStack(spacing: 12) {
                Avatar(url: t.imageURL, name: t.name, size: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text(["\(t.members) member\(t.members == 1 ? "" : "s")", t.mine ? "your team" : nil].compactMap { $0 }.joined(separator: " · ")).foregroundStyle(.white)
                    Button("Open the challenge") { model.openChallenge(t.challengeId) }.buttonStyle(.plain).foregroundStyle(.white).fontWeight(.semibold)
                }.font(.subheadline)
            }.padding(.top, 8)
        })
        if (!t.mine && inChallenge) || t.canManage {
            HStack {
                if !t.mine && inChallenge { Button("Join this team") { Task { await model.joinTeam(t.challengeId, t.id); await load() } }.buttonStyle(.borderedProminent).tint(Color.brandRed) }
                if t.canManage { Button("Manage") { router.push(.manageTeam(t.challengeId, t.id)) }.buttonStyle(.bordered) }
            }
        }
        SectionCard("Progress") {
            let perMember = active > 0 ? Totals(minutes: (t.total.minutes / Double(active)).rounded(), distance: (t.total.distance / Double(active) * 100).rounded() / 100, steps: (t.total.steps / Double(active)).rounded()) : nil
            let tiles: [(String, Totals)] = [("all time", t.total), ("this month", t.month), ("this week", t.week)] + (perMember.map { [("per member", $0)] } ?? [])
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(tiles.indices, id: \.self) { i in
                    let (label, x) = tiles[i]
                    VStack(alignment: .leading, spacing: 2) {
                        Text(amount(x)).font(.headline)
                        Text(label).font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 10)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                }
            }
            // On a journey: how far along the route, and what's next.
            if let p = t.progress {
                Text("On the journey").font(.subheadline.bold()).padding(.top, 4)
                ProgressView(value: p).tint(Color.brandRed)
                let unitWord = t.journeyUnit ?? ""
                Text(t.finishedOn.map { "🏁 Finished on \($0)" } ?? ("\(Int((p * 100).rounded()))% of the way" +
                    (t.nextName.map { n in " · \(t.nextRemaining.map { $0 >= 10 ? String(Int($0.rounded())) : fmtNum($0) } ?? "") \(unitWord) to \(n)" } ?? "")))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        // The last fortnight of the challenge so far, a bar a day.
        if !t.days.isEmpty {
            SectionCard(t.days.count == 14 ? "The last fortnight" : "The last \(t.days.count) day\(t.days.count == 1 ? "" : "s")") {
                let top = max(1, t.days.map { $0.total.value(t.measure) }.max() ?? 1)
                HStack(alignment: .bottom, spacing: 4) {
                    ForEach(t.days, id: \.date) { d in
                        VStack(spacing: 3) {
                            GeometryReader { g in
                                VStack { Spacer(minLength: 0)
                                    UnevenRoundedRectangle(topLeadingRadius: 3, topTrailingRadius: 3).fill(Color.brandRed)
                                        .frame(height: max(2, g.size.height * d.total.value(t.measure) / top))
                                }
                            }
                            Text(d.date.date.formatted(.dateTime.weekday(.narrow))).font(.caption2).foregroundStyle(.secondary)
                        }
                        .accessibilityElement().accessibilityLabel("\(fmtDay(d.date)): \(amount(d.total))")
                    }
                }.frame(height: 110)
                if let best = t.days.max(by: { $0.total.value(t.measure) < $1.total.value(t.measure) }), best.total.value(t.measure) > 0 {
                    Text("Best day: \(fmtDay(best.date)), \(amount(best.total))").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        SectionCard("Members") {
            if t.people.isEmpty { EmptyNote("Nobody in this team yet.") }
            let places = Dictionary(uniqueKeysWithValues: t.people.filter { !$0.former }.enumerated().map { ($1.id, $0 + 1) })
            ForEach(Array(t.people.enumerated()), id: \.element.id) { i, m in
                Button { router.push(.user(m.id)) } label: {
                    HStack {
                        Text(places[m.id].map(String.init) ?? "").font(.headline.weight(.black)).foregroundStyle((places[m.id] ?? 99) <= 3 ? Color.brandRed : .secondary).frame(width: 28, alignment: .leading)
                        Avatar(url: m.avatarURL, name: m.name)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.name + (m.id == model.me?.id ? " (you)" : "")).font(.headline).foregroundStyle(Color.brandRed)
                            Text([m.former ? "left the team" : m.teamAdmin ? "team admin" : nil, "\(amount(m.week)) this week"].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(amount(m.total)).font(.headline).foregroundStyle(.primary)
                            ProgressView(value: min(1, max(0, m.share))).tint(Color.brandRed).frame(width: 90)
                            Text("\(Int((m.share * 100).rounded()))% of the team").font(.caption2).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 4).contentShape(Rectangle())
                }.buttonStyle(.plain)
                if i < t.people.count - 1 { Divider() }
            }
        }
        if !t.activities.isEmpty {
            SectionCard("Latest entries") {
                EmptyNote("Yours, and from people who share their full activity.")
                ForEach(t.activities) { e in
                    HStack {
                        Avatar(url: e.avatarURL, name: e.name)
                        VStack(alignment: .leading) {
                            Button(e.name) { router.push(.user(e.userId)) }.font(.subheadline.weight(.semibold)).buttonStyle(.plain).foregroundStyle(Color.brandRed)
                            Text([e.type, fmtDay(e.date), e.comment.map { "“\($0)”" }].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(fmtMeasure(t.measure, minutes: e.minutes ?? 0, distance: e.distance ?? 0, steps: Double(e.steps ?? 0), unit: t.distanceUnit)).bold()
                        if e.userId == model.me?.id { if e.kudos > 0 { Text("👏 \(e.kudos)").font(.caption) } }
                        else { KudosButton(activityId: e.id, count: e.kudos, mine: e.kudosMine) }
                    }
                }
            }
        }
    }
}
