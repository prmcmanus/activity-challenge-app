import SwiftUI

struct SyncView: View {
    @Environment(AppModel.self) private var model
    @State private var needsAsking = false
    @State private var asking = false

    var body: some View {
        Page(refresh: { await checkAccess(); if model.review != nil { await model.startReview() } }) {
            Hero("Apple Health", "Sync workouts") {
                Text("Workouts from Apple Health go into every challenge they fit, and daily steps into step challenges.").font(.subheadline).foregroundStyle(.white.opacity(0.9))
            }
            if !model.health.isAvailable {
                SectionCard { EmptyNote("Apple Health isn't available on this device.") }
            } else {
                SectionCard("Access") {
                    if needsAsking {
                        Text("Allow Active Together to read your workouts, their distance\(Prefs.includeRoutes ? " and routes" : ""), and your steps.").font(.subheadline)
                        Button("Allow access") { Task { asking = true; try? await model.health.requestAccess(withRoutes: Prefs.includeRoutes); asking = false; await checkAccess() } }
                            .buttonStyle(.borderedProminent).disabled(asking)
                    } else {
                        Label("Apple Health has been asked", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    }
                    Text("To change what's shared: Settings › Health › Data Access & Devices › Active Together. Apple Health never tells apps what was declined, so a missing workout may just need access there.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let review = model.review {
                Text("Tick the workouts to sync, check the type and distance, and choose the challenges each one counts in.").font(.subheadline)
                ForEach(review) { item in ReviewCard(item: item) }
                let count = review.filter { $0.include && !$0.into.isEmpty }.count
                HStack {
                    Button { model.cancelReview() } label: { Text("Cancel").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
                    Button { Task { await model.uploadReview() } } label: {
                        Group { if model.syncBusy { ProgressView().tint(.white) } else { Text(count == 1 ? "Sync 1 workout" : "Sync \(count) workouts") } }.frame(maxWidth: .infinity)
                    }.buttonStyle(.borderedProminent).disabled(count == 0 || model.syncBusy)
                }.controlSize(.large)
            } else {
                Button { Task { await model.startReview() } } label: {
                    Group { if model.syncBusy { ProgressView().tint(.white) } else { Label("Review workouts to sync", systemImage: "arrow.triangle.2.circlepath") } }.frame(maxWidth: .infinity)
                }.buttonStyle(.borderedProminent).controlSize(.large).disabled(model.syncBusy || !model.health.isAvailable)
                let status = model.syncStatus.isEmpty ? (Prefs.lastSyncSummary.isEmpty ? "" : "Last sync: \(Prefs.lastSyncSummary)") : model.syncStatus
                if !status.isEmpty { Text(status).font(.subheadline) }
            }
        }
        .navigationTitle("Active Together").navigationBarTitleDisplayMode(.inline)
        .task { await checkAccess() }
    }

    private func checkAccess() async { needsAsking = await model.health.needsAsking(withRoutes: Prefs.includeRoutes) }
}

private struct ReviewCard: View {
    @Bindable var item: ReviewItem
    var body: some View {
        let w = item.candidate.workout
        SectionCard {
            HStack {
                Toggle(isOn: $item.include) {
                    VStack(alignment: .leading) {
                        Text("\(fmtDay(w.day)) · \(w.startTime)–\(w.endTime)").font(.headline)
                        Text("\(w.minutes) min · from \(w.sourceApp)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if item.include {
                Picker("Activity type", selection: $item.type) { ForEach(activityTypes.contains(item.type) ? activityTypes : [item.type] + activityTypes, id: \.self) { Text($0).tag($0) } }
                HStack {
                    TextField("Distance", text: Binding(get: { item.distanceText }, set: { item.distanceEdited($0) })).keyboardType(.decimalPad).textFieldStyle(.roundedBorder)
                    Picker("", selection: Binding(get: { item.unit }, set: { item.switchUnit($0) })) { Text("miles").tag("mi"); Text("km").tag("km") }.pickerStyle(.segmented).frame(width: 130)
                }
                if w.distanceMeters == nil { Text("Distance not recorded - type it if you know it").font(.caption).foregroundStyle(.secondary) }
                Text("Counts in").font(.caption.bold()).foregroundStyle(.secondary)
                ForEach(item.candidate.fits) { c in
                    let already = item.candidate.alreadyIn.contains(c.id)
                    let needsDistance = c.measuresDistance && item.distanceMeters() == nil
                    Button {
                        if item.into.contains(c.id) { item.into.remove(c.id) } else { item.into.insert(c.id) }
                    } label: {
                        HStack {
                            Image(systemName: already || item.into.contains(c.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(Color.brandRed)
                            Text(c.name + (already ? " · synced" : needsDistance && item.into.contains(c.id) ? " · needs distance" : "")).foregroundStyle(.primary)
                        }
                    }.disabled(already)
                }
                if Prefs.includeRoutes, case .available(let pts) = w.route {
                    Label("Route included (\(pts.count) points)", systemImage: "point.topleft.down.to.point.bottomright.curvepath").font(.subheadline.bold()).foregroundStyle(.green)
                }
            }
        }
    }
}
