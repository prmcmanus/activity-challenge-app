import SwiftUI
import MapKit

struct ActivityListView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router

    var body: some View {
        Page(refresh: { await model.refreshTop() }) {
            Text("My activity").font(.title2.bold())
            if model.activities.isEmpty && !model.loadingActivities {
                SectionCard { EmptyNote("Nothing logged yet. Tap + to log an activity, or sync your workouts from the Sync tab.") }
            }
            // One card per workout: entries for the same workout in several challenges are listed under it.
            ForEach(groups, id: \.first!.id) { entries in
                let a = entries[0]
                Button { router.push(.activity(a.id)) } label: {
                    SectionCard {
                        HStack {
                            Image(systemName: a.hasRoute ? "map" : a.measure == .steps ? "shoeprints.fill" : "figure.run").font(.title2).foregroundStyle(Color.brandRed).frame(width: 40)
                            VStack(alignment: .leading) {
                                Text(a.type).font(.headline).foregroundStyle(.primary)
                                Text([fmtDay(a.date), a.startTime].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(fmtEntry(a)).font(.headline).foregroundStyle(.primary)
                        }
                        Text(entries.map { $0.challengeName + ($0.teamName.map { " (\($0))" } ?? "") }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }
                }.buttonStyle(.plain)
            }
            if model.moreActivities {
                Button("Show more") { Task { await model.loadActivities(reset: false) } }.frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Active Together").navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottomTrailing) {
            Button { router.push(.log) } label: { Label("Log activity", systemImage: "plus").bold().padding(.horizontal, 18).padding(.vertical, 14) }
                .foregroundStyle(.white).background(Color.brandRed, in: Capsule()).shadow(radius: 4).padding(20)
        }
    }

    private var groups: [[MyActivity]] {
        var order: [String] = [], map: [String: [MyActivity]] = [:]
        for a in model.activities {
            let k = "\(a.date)|\(a.type)|\(a.startTime ?? "")|\(a.minutes ?? -1)|\(a.source)|\(a.comment ?? "")"
            if map[k] == nil { order.append(k) }
            map[k, default: []].append(a)
        }
        return order.map { map[$0]! }
    }
}

struct RouteMapView: View {
    let points: [RoutePoint]
    var body: some View {
        let coords = points.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
        Map(initialPosition: .automatic) {
            MapPolyline(coordinates: coords).stroke(Color.brandRed, lineWidth: 4)
            if let first = coords.first { Annotation("Start", coordinate: first) { Circle().fill(.green).frame(width: 12, height: 12) } }
            if let last = coords.last { Annotation("Finish", coordinate: last) { Circle().fill(Color.brandRed).frame(width: 12, height: 12) } }
        }
    }
}

struct ActivityDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    let activityId: Int
    @State private var route: [RoutePoint]?
    @State private var confirm: MyActivity?

    var body: some View {
        if let a = model.activities.first(where: { $0.id == activityId }) { content(a) } else { ProgressView() }
    }

    private func content(_ a: MyActivity) -> some View {
        let siblings = model.siblings(of: a)
        return Page(refresh: { await model.refreshActivities(); if a.hasRoute { route = try? await model.api.route(activityId: a.id) } }) {
            Hero(eyebrow: [fmtDay(a.date), a.startTime.map { s in a.endTime.map { "\(s)–\($0)" } ?? s }].compactMap { $0 }.joined(separator: " · "), title: a.type, trailing: {
                HeroStat(value: fmtEntry(a).components(separatedBy: " · ")[0].replacingOccurrences(of: " steps", with: ""),
                         label: a.measure == .steps ? "steps" : a.measure == .distance ? "distance" : "active")
            }, below: { EmptyView() })
            Button { router.push(.editActivity(a.id)) } label: { Label(a.measure == .steps ? "Edit steps" : "Edit activity", systemImage: "pencil").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large)
            if a.hasRoute {
                SectionCard("Route") {
                    if let route { RouteMapView(points: route).frame(height: 320).clipShape(RoundedRectangle(cornerRadius: 14)) }
                    else { ProgressView().frame(maxWidth: .infinity, minHeight: 260) }
                    Text("Only you can see your route.").font(.caption).foregroundStyle(.secondary)
                }
            }
            SectionCard("Logged in") {
                ForEach(siblings) { e in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(e.challengeName).font(.headline)
                            Text([e.teamName, fmtEntry(e)].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Remove", systemImage: "trash", role: .destructive) { confirm = e }.labelStyle(.titleAndIcon).font(.subheadline)
                    }
                }
            }
            if let c = a.comment, !c.isEmpty { SectionCard("Comment") { Text("“\(c)”") } }
            Text("Source: \(a.source == "manual" ? "logged by hand" : a.source == "health_kit" ? "Apple Health" : a.source == "health_connect" ? "Health Connect" : a.source)")
                .font(.caption).foregroundStyle(.secondary)
        }
        .navigationTitle("Activity").navigationBarTitleDisplayMode(.inline)
        .task(id: activityId) { if a.hasRoute, route == nil { route = try? await model.api.route(activityId: a.id) } }
        .confirmationDialog("Remove from \(confirm?.challengeName ?? "")?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                guard let e = confirm else { return }
                let last = siblings.count == 1
                Task { if await model.deleteActivity(e), last { router.pop() } }
            }
        } message: { Text("This entry stops counting in that challenge. It stays in any other challenge it was logged into.") }
    }
}

/// Log an activity by hand into every challenge it should count in.
struct LogActivityView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var type = "Walking"
    @State private var date = Date()
    @State private var useTimes = false
    @State private var start = Calendar.current.date(bySettingHour: 7, minute: 0, second: 0, of: Date())!
    @State private var end = Calendar.current.date(bySettingHour: 7, minute: 30, second: 0, of: Date())!
    @State private var minutes = ""
    @State private var distance = ""
    @State private var unit = Prefs.preferredUnit
    @State private var steps = ""
    @State private var comment = ""
    @State private var chosen: Set<Int> = []
    @State private var busy = false
    @State private var error: String?

    private var fits: [Challenge] { model.challenges.filter { $0.contains(Day(date)) && $0.target != nil } }

    var body: some View {
        Form {
            Section {
                Picker("Activity", selection: $type) { ForEach(activityTypes, id: \.self) { Text($0).tag($0) } }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                Toggle("Start and finish times", isOn: $useTimes)
                if useTimes {
                    DatePicker("Start", selection: $start, displayedComponents: .hourAndMinute)
                    DatePicker("Finish", selection: $end, displayedComponents: .hourAndMinute)
                }
                HStack {
                    TextField("Distance", text: $distance).keyboardType(.decimalPad)
                    Picker("", selection: $unit) { Text("miles").tag("mi"); Text("km").tag("km") }.pickerStyle(.segmented).frame(width: 130)
                }
                TextField("Minutes", text: $minutes).keyboardType(.numberPad)
                if fits.contains(where: \.measuresSteps) {
                    TextField("Steps that day", text: $steps).keyboardType(.numberPad)
                    Text("For step challenges. Syncing fills this in from Apple Health each day.").font(.caption).foregroundStyle(.secondary)
                }
                TextField("Comment (optional)", text: $comment)
            }
            Section("Count it in") {
                if fits.isEmpty { EmptyNote("None of your challenges run on \(fmtDay(Day(date))).") }
                ForEach(fits) { c in
                    Button { if chosen.contains(c.id) { chosen.remove(c.id) } else { chosen.insert(c.id) } } label: {
                        HStack {
                            Image(systemName: chosen.contains(c.id) ? "checkmark.square.fill" : "square").foregroundStyle(Color.brandRed)
                            VStack(alignment: .leading) {
                                Text(c.name).foregroundStyle(.primary)
                                Text((c.measuresSteps ? "Needs steps" : c.measuresDistance ? "Needs a distance" : "Needs minutes") + (c.individual ? "" : " · \(c.myTeams.first?.name ?? "")"))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Button(chosen.count > 1 ? "Log in \(chosen.count) challenges" : "Log activity") { save() }.disabled(busy || chosen.isEmpty).bold()
        }
        .navigationTitle("Log activity").navigationBarTitleDisplayMode(.inline)
        // Every challenge the date falls in is ticked by default, as it changes.
        .onChange(of: Day(date), initial: true) { _, _ in chosen = Set(fits.map(\.id)) }
        .onChange(of: useTimes) { _, _ in recalc() }
        .onChange(of: start) { _, _ in recalc() }
        .onChange(of: end) { _, _ in recalc() }
        .onAppear { if let u = fits.first(where: \.measuresDistance)?.distanceUnit { unit = u } }
    }

    /// Start and finish fill in the minutes, as on the web form.
    private func recalc() {
        guard useTimes else { return }
        let m = Int(end.timeIntervalSince(start) / 60)
        if m > 0 { minutes = String(m) }
    }

    private func save() {
        busy = true; error = nil
        let targets = fits.filter { chosen.contains($0.id) }.compactMap(\.target)
        let dist = Double(distance.replacingOccurrences(of: ",", with: ".")).flatMap { $0 > 0 ? $0 : nil }
        let mins = Int(minutes).flatMap { $0 > 0 ? $0 : nil }
        let stepCount = Int(steps).flatMap { $0 > 0 ? $0 : nil }
        let hhmm = DeviceWorkout.hhmm
        Task {
            let body = model.api.activityBody(targets: targets, type: type, date: Day(date), minutes: mins, distance: dist, unit: unit,
                                              start: useTimes ? hhmm.string(from: start) : nil, end: useTimes ? hhmm.string(from: end) : nil, comment: comment, steps: stepCount)
            let n = await model.logActivity(body, expected: targets.count)
            busy = false
            if n == -1 { model.message = "No connection: saved on this phone, and it'll be sent when you're back online"; router.pop() }
            else if let n { model.message = "Logged in \(n) challenge\(n == 1 ? "" : "s")"; await model.afterChange(); router.pop() }
            else { error = model.message; model.message = nil }
        }
    }
}

/// Edit a workout - saved to every challenge it's logged in - or a step-challenge day.
struct EditActivityView: View {
    @Environment(AppModel.self) private var model
    let activityId: Int
    var body: some View {
        if let a = model.activities.first(where: { $0.id == activityId }) {
            if a.measure == .steps { EditStepsForm(a: a) } else { EditWorkoutForm(a: a, entries: model.siblings(of: a)) }
        } else { ProgressView() }
    }
}

private struct EditWorkoutForm: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    let a: MyActivity, entries: [MyActivity]
    @State private var type = ""
    @State private var date = Date()
    @State private var useTimes = false
    @State private var start = Date()
    @State private var end = Date()
    @State private var minutes = ""
    @State private var distance = ""
    @State private var unit = "mi"
    @State private var comment = ""
    @State private var busy = false
    @State private var loaded = false

    var body: some View {
        Form {
            Section {
                Picker("Activity", selection: $type) { ForEach(activityTypes.contains(type) ? activityTypes : [type] + activityTypes, id: \.self) { Text($0).tag($0) } }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                Toggle("Start and finish times", isOn: $useTimes)
                if useTimes {
                    DatePicker("Start", selection: $start, displayedComponents: .hourAndMinute)
                    DatePicker("Finish", selection: $end, displayedComponents: .hourAndMinute)
                }
                HStack {
                    TextField("Distance", text: $distance).keyboardType(.decimalPad)
                    Picker("", selection: $unit) { Text("miles").tag("mi"); Text("km").tag("km") }.pickerStyle(.segmented).frame(width: 130)
                }
                TextField("Minutes", text: $minutes).keyboardType(.numberPad)
                TextField("Comment (optional)", text: $comment)
            }
            if entries.count > 1 {
                Text("Saved in all \(entries.count) challenges this is logged in: \(entries.map(\.challengeName).joined(separator: ", ")).").font(.caption).foregroundStyle(.secondary)
            }
            Button("Save changes") {
                busy = true
                let hhmm = DeviceWorkout.hhmm
                Task {
                    let ok = await model.editWorkout(entries, type: type, date: Day(date), minutes: Int(minutes).flatMap { $0 > 0 ? $0 : nil },
                                                     distance: Double(distance.replacingOccurrences(of: ",", with: ".")).flatMap { $0 > 0 ? $0 : nil }, unit: unit,
                                                     start: useTimes ? hhmm.string(from: start) : nil, end: useTimes ? hhmm.string(from: end) : nil, comment: comment)
                    busy = false
                    if ok { router.pop() }
                }
            }.disabled(busy).bold()
        }
        .navigationTitle("Edit activity").navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            type = a.type; date = a.date.date; comment = a.comment ?? ""; unit = a.distanceUnit
            minutes = a.minutes.map(fmtNum) ?? ""; distance = a.distance.map(fmtNum) ?? ""
            let hhmm = DeviceWorkout.hhmm
            if let s = a.startTime.flatMap(hhmm.date(from:)), let e = a.endTime.flatMap(hhmm.date(from:)) {
                useTimes = true
                start = Calendar.current.date(bySettingHour: Calendar.current.component(.hour, from: s), minute: Calendar.current.component(.minute, from: s), second: 0, of: Date())!
                end = Calendar.current.date(bySettingHour: Calendar.current.component(.hour, from: e), minute: Calendar.current.component(.minute, from: e), second: 0, of: Date())!
            }
        }
    }
}

/// A step-challenge entry is a day and a count.
private struct EditStepsForm: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    let a: MyActivity
    @State private var date = Date()
    @State private var steps = ""
    @State private var comment = ""
    @State private var busy = false
    @State private var loaded = false
    var body: some View {
        Form {
            DatePicker("Date", selection: $date, displayedComponents: .date)
            TextField("Steps that day", text: $steps).keyboardType(.numberPad)
            TextField("Comment (optional)", text: $comment)
            if a.source != "manual" {
                Text("This day came from your phone. The next sync sets it back to the phone's count if they differ.").font(.caption).foregroundStyle(.secondary)
            }
            Button("Save changes") {
                busy = true
                Task {
                    let ok = await model.call { try await $0.editSteps(a.id, date: Day(date), steps: Int(steps) ?? 0, comment: comment) } != nil
                    busy = false
                    if ok { model.message = "Steps updated"; await model.afterChange(); router.pop() }
                }
            }.disabled(busy || (Int(steps) ?? 0) <= 0).bold()
        }
        .navigationTitle("Edit steps").navigationBarTitleDisplayMode(.inline)
        .onAppear { if !loaded { loaded = true; date = a.date.date; steps = a.steps.map(String.init) ?? ""; comment = a.comment ?? "" } }
    }
}
