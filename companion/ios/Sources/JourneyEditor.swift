import SwiftUI
import MapKit

private let maxStops = 10

/// A place on the journey being set up. custom: the owner typed its label, so moving it keeps the name.
struct DraftPlace: Hashable { var name: String, lat: Double, lon: Double, custom = false }

/// The journey an owner is setting up: start, finish, stops (nil while one is being searched for), how and which way.
@MainActor @Observable final class JourneyDraft {
    var mode: String, shape: String
    var from: DraftPlace?, to: DraftPlace?
    var via: [DraftPlace?]
    var preview: JourneyPreview?
    var status: String?
    var statusIsError = false

    init(_ j: Journey?) {
        mode = j?.mode ?? "foot"; shape = j?.shape ?? "roads"
        from = j.map { DraftPlace(name: $0.fromName, lat: $0.fromLat, lon: $0.fromLon, custom: true) }
        to = j.map { DraftPlace(name: $0.toName, lat: $0.toLat, lon: $0.toLon, custom: true) }
        via = j?.via.map { DraftPlace(name: $0.name, lat: $0.lat, lon: $0.lon, custom: true) } ?? []
    }
    var cycling: Bool { mode == "cycling" }
    /// What's sent to the server, once there's a start and a finish.
    var value: JourneyInput? {
        guard let f = from, let t = to else { return nil }
        func p(_ x: DraftPlace) -> JourneyPlace { JourneyPlace(name: x.name.isEmpty ? String(format: "%.4f, %.4f", x.lat, x.lon) : x.name, lat: x.lat, lon: x.lon) }
        return JourneyInput(from: p(f), to: p(t), via: via.compactMap { $0 }.map(p), shape: shape, mode: mode)
    }
    /// Changes that need the route planned again (not the labels).
    var routeKey: String {
        [from.map { "\($0.lat),\($0.lon)" }, to.map { "\($0.lat),\($0.lon)" }, via.compactMap { $0 }.map { "\($0.lat),\($0.lon)" }.joined(separator: ";"), shape, mode]
            .map { $0 ?? "" }.joined(separator: "|")
    }
    /// "London → Edinburgh: 412 miles (663 km) by road, about 880,000 steps", once planned.
    var summary: String? {
        guard let pv = preview, let f = from, let t = to else { return nil }
        let stops = via.compactMap { $0 }
        return "\(f.name) → \(t.name)\(stops.isEmpty ? "" : " via " + stops.map(\.name).joined(separator: ", ")): \(fmtLen(pv.miles)) miles (\(fmtLen(pv.km)) km) "
            + "\(shape == "straight" ? "as the crow flies" : "by road"), about \(fmtSteps(pv.steps)) steps"
    }
    func get(_ k: String) -> DraftPlace? { k == "from" ? from : k == "to" ? to : via[Int(k.dropFirst(3))!] }
    func put(_ k: String, _ p: DraftPlace?) { if k == "from" { from = p } else if k == "to" { to = p } else { via[Int(k.dropFirst(3))!] = p } }
}

private func fmtLen(_ v: Double) -> String { v >= 100 ? "\(Int(v.rounded()))" : fmtNum((v * 10).rounded() / 10) }

private func haversine(_ a: (Double, Double), _ b: (Double, Double)) -> Double {
    let r = 6371000.0, dLat = (b.0 - a.0) * .pi / 180, dLon = (b.1 - a.1) * .pi / 180
    let h = pow(sin(dLat / 2), 2) + cos(a.0 * .pi / 180) * cos(b.0 * .pi / 180) * pow(sin(dLon / 2), 2)
    return 2 * r * asin(sqrt(h))
}

/// The form's summary of the journey, with a button to set the route on its own full-screen page.
struct JourneySection: View {
    @Bindable var draft: JourneyDraft
    let editing: Bool
    @State private var open = false
    var body: some View {
        Section {
            if let f = draft.from, let t = draft.to {
                Text(draft.summary ?? "\(f.name) → \(t.name)").font(.subheadline)
            } else {
                Text("No route yet.").foregroundStyle(.secondary)
            }
            Button(draft.from == nil ? "Set the route" : "Change the route") { open = true }
        } header: { Text("The journey") } footer: {
            Text(editing ? "Changing the route moves everyone along the new one by what they've already logged."
                 : "Teams or people travel a route on a map (say, London to Edinburgh) by the distance or steps they log.")
        }
        .fullScreenCover(isPresented: $open) {
            NavigationStack {
                JourneyEditorView(draft: draft)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { open = false } } }
            }
        }
    }
}

/**
 * Setting up a virtual journey, as on the website: start and finish (and up to 10 stops) from a place search or a tap on
 * the map - the first tap sets the start, the next the finish, any more add a stop where it makes the least detour. Each
 * place can be relabelled. The route and its length are previewed as it changes.
 */
struct JourneyEditorView: View {
    @Environment(AppModel.self) private var model
    @Bindable var draft: JourneyDraft
    @State private var camera: MapCameraPosition = .region(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 54, longitude: -2.5), span: MKCoordinateSpan(latitudeDelta: 12, longitudeDelta: 12)))

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                map.frame(height: 320).clipShape(RoundedRectangle(cornerRadius: 12))
                Text("Tap the map: the first tap sets the start, the next the finish, and any more add stops.").font(.caption).foregroundStyle(.secondary)
                if let s = draft.status { Text(s).font(.subheadline).foregroundStyle(draft.statusIsError ? .red : .secondary) }
                else if let s = draft.summary { Text(s).font(.subheadline.weight(.semibold)) }
                Picker("Getting there", selection: $draft.mode) { Text("On foot").tag("foot"); Text("Cycling only").tag("cycling") }.pickerStyle(.segmented)
                Picker("Route", selection: $draft.shape) { Text("Roads and paths").tag("roads"); Text("Straight line").tag("straight") }.pickerStyle(.segmented)
                PlaceField(title: "Start", key: "from", draft: draft)
                PlaceField(title: "Finish", key: "to", draft: draft)
                ForEach(Array(draft.via.indices), id: \.self) { i in
                    PlaceField(title: "Stop \(i + 1)", key: "via\(i)", draft: draft) {
                        Button { draft.via.swapAt(i, i - 1) } label: { Image(systemName: "arrow.up") }.disabled(i == 0).accessibilityLabel("Earlier")
                        Button { draft.via.swapAt(i, i + 1) } label: { Image(systemName: "arrow.down") }.disabled(i == draft.via.count - 1).accessibilityLabel("Later")
                        Button(role: .destructive) { draft.via.remove(at: i) } label: { Image(systemName: "xmark") }.accessibilityLabel("Remove stop")
                    }
                }
                Button("+ Add a stop on the way") {
                    if draft.via.count >= maxStops { draft.status = "A journey can have up to \(maxStops) stops on the way."; draft.statusIsError = true } else { draft.via.append(nil) }
                }.buttonStyle(.bordered)
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("The route").navigationBarTitleDisplayMode(.inline)
        // Plan the route a moment after the last change, and frame it.
        .task(id: draft.routeKey) {
            guard let j = draft.value else { draft.preview = nil; draft.status = "Choose a start and a finish."; draft.statusIsError = false; frame(); return }
            draft.status = "Planning the route…"; draft.statusIsError = false
            try? await Task.sleep(for: .milliseconds(400))
            if Task.isCancelled { return }
            do { draft.preview = try await model.api.previewJourney(j); draft.status = nil }
            catch { if !Task.isCancelled { draft.preview = nil; draft.status = (error as? APIError)?.message ?? "Couldn't reach Active Together: \(error.localizedDescription)"; draft.statusIsError = true } }
            frame()
        }
    }

    private var line: [CLLocationCoordinate2D] {
        if let pv = draft.preview { return pv.points.map { CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) } }
        guard let f = draft.from, let t = draft.to else { return [] }
        return ([f] + draft.via.compactMap { $0 } + [t]).map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
    }

    private var map: some View {
        MapReader { proxy in
            Map(position: $camera) {
                if line.count >= 2 { MapPolyline(coordinates: line).stroke(Color.brandRed.opacity(draft.preview == nil ? 0.4 : 1), lineWidth: 4) }
                ForEach(Array(draft.via.compactMap { $0 }.enumerated()), id: \.offset) { i, s in
                    Annotation("Stop \(i + 1): \(s.name)", coordinate: CLLocationCoordinate2D(latitude: s.lat, longitude: s.lon)) {
                        Text("\(i + 1)").font(.caption2.bold()).foregroundStyle(.white).frame(width: 20, height: 20)
                            .background(Circle().fill(.black)).overlay(Circle().stroke(.white, lineWidth: 2))
                    }
                    .annotationTitles(.hidden)
                }
                if let f = draft.from {
                    Annotation("Start: \(f.name)", coordinate: CLLocationCoordinate2D(latitude: f.lat, longitude: f.lon)) {
                        Circle().fill(.white).frame(width: 14, height: 14).overlay(Circle().stroke(.black, lineWidth: 4)).shadow(radius: 1)
                    }
                    .annotationTitles(.hidden)
                }
                if let t = draft.to {
                    Annotation("Finish: \(t.name)", coordinate: CLLocationCoordinate2D(latitude: t.lat, longitude: t.lon), anchor: .bottomLeading) { Text("🏁").font(.title2) }
                        .annotationTitles(.hidden)
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .onTapGesture { pt in if let c = proxy.convert(pt, from: .local) { tap(c.latitude, c.longitude) } }
        }
    }

    /// Fit the map to the places (or the planned route).
    private func frame() {
        let pts = line.isEmpty ? [draft.from, draft.to].compactMap { $0 }.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) } : line
        guard let first = pts.first else { return }
        if pts.count == 1 { withAnimation { camera = .region(MKCoordinateRegion(center: first, span: MKCoordinateSpan(latitudeDelta: 0.4, longitudeDelta: 0.4))) }; return }
        let lats = pts.map(\.latitude), lons = pts.map(\.longitude)
        let center = CLLocationCoordinate2D(latitude: (lats.min()! + lats.max()!) / 2, longitude: (lons.min()! + lons.max()!) / 2)
        let span = MKCoordinateSpan(latitudeDelta: max(0.02, (lats.max()! - lats.min()!) * 1.35), longitudeDelta: max(0.02, (lons.max()! - lons.min()!) * 1.35))
        withAnimation { camera = .region(MKCoordinateRegion(center: center, span: span)) }
    }

    private func tap(_ lat: Double, _ lon: Double) {
        guard let f = draft.from else { setPoint("from", lat, lon); return }
        guard let t = draft.to else { setPoint("to", lat, lon); return }
        draft.via.removeAll { $0 == nil }
        if draft.via.count >= maxStops { draft.status = "A journey can have up to \(maxStops) stops on the way."; draft.statusIsError = true; return }
        let pts = [f] + draft.via.compactMap { $0 } + [t]
        let best = (0..<(pts.count - 1)).min { i, j in
            func cost(_ k: Int) -> Double { haversine((pts[k].lat, pts[k].lon), (lat, lon)) + haversine((lat, lon), (pts[k + 1].lat, pts[k + 1].lon)) - haversine((pts[k].lat, pts[k].lon), (pts[k + 1].lat, pts[k + 1].lon)) }
            return cost(i) < cost(j)
        } ?? 0
        draft.via.insert(DraftPlace(name: "", lat: lat, lon: lon), at: best)
        setPoint("via\(best)", lat, lon)
    }

    /// A tapped place, named by looking it up. An owner's own label survives a move.
    private func setPoint(_ k: String, _ lat: Double, _ lon: Double) {
        if let before = draft.get(k), before.custom { draft.put(k, DraftPlace(name: before.name, lat: lat, lon: lon, custom: true)); return }
        draft.put(k, DraftPlace(name: "Finding the place name…", lat: lat, lon: lon))
        Task {
            let n = (try? await model.api.placeName(lat: lat, lon: lon)) ?? nil
            if let p = draft.get(k), !p.custom, p.lat == lat, p.lon == lon { draft.put(k, DraftPlace(name: n ?? String(format: "%.3f, %.3f", lat, lon), lat: lat, lon: lon)) }
        }
    }
}

/// One place: a search box with its results, then (once picked) what the challenge calls it.
private struct PlaceField<Actions: View>: View {
    @Environment(AppModel.self) private var model
    let title: String, key: String
    @Bindable var draft: JourneyDraft
    @ViewBuilder var actions: Actions
    @State private var query = ""
    @State private var results: [PlaceResult]?
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack { Text(title).font(.headline); Spacer(); actions }
            HStack {
                TextField("Search for a place", text: $query).textFieldStyle(.roundedBorder).submitLabel(.search).onSubmit(find)
                Button(action: find) { Image(systemName: "magnifyingglass") }.buttonStyle(.bordered).accessibilityLabel("Find")
            }
            if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
            if let results {
                ForEach(results) { p in
                    Button { self.results = nil; query = ""; draft.put(key, DraftPlace(name: p.name, lat: p.lat, lon: p.lon)) } label: {
                        Text(p.detail).font(.subheadline).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(.vertical, 4)
                    Divider()
                }
            }
            if let place = draft.get(key) {
                TextField("Shown as", text: Binding(get: { place.name }, set: { v in
                    if var p = draft.get(key) { p.name = String(v.prefix(120)); p.custom = !v.isEmpty; draft.put(key, p) }
                })).textFieldStyle(.roundedBorder)
                Text(String(format: "%.4f, %.4f", place.lat, place.lon)).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func find() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { return }
        note = "Searching…"; results = nil
        Task {
            do { let r = try await model.api.searchPlaces(q); results = r; note = r.isEmpty ? "Nothing found - try another name, or tap the map." : nil }
            catch { note = (error as? APIError)?.message ?? error.localizedDescription }
        }
    }
}

extension PlaceField where Actions == EmptyView {
    init(title: String, key: String, draft: JourneyDraft) { self.init(title: title, key: key, draft: draft, actions: { EmptyView() }) }
}
