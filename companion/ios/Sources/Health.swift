import Foundation
import HealthKit
import CoreLocation

/// Whether a workout's GPS route can be read.
enum RouteState: Hashable {
    case available([RoutePoint])
    case none
}

/// One workout as Apple Health has it, before it is matched to any challenge.
struct DeviceWorkout: Hashable {
    let sourceRef: String, type: String, start: Date, end: Date, minutes: Int, distanceMeters: Double?, route: RouteState, sourceApp: String
    var day: Day { Day(start) }
    var startTime: String { Self.hhmm.string(from: start) }
    var endTime: String { Self.hhmm.string(from: end) }
    static let hhmm: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm"; f.locale = Locale(identifier: "en_US_POSIX"); return f }()
}

/// Reads workouts (duration, distance, type, route) and daily step counts from Apple Health. Nothing is written.
final class HealthStore: @unchecked Sendable {
    let store = HKHealthStore()
    private let distanceTypes: [HKQuantityType] = [
        HKQuantityType(.distanceWalkingRunning), HKQuantityType(.distanceCycling), HKQuantityType(.distanceSwimming),
        HKQuantityType(.distanceWheelchair), HKQuantityType(.distanceDownhillSnowSports),
    ]
    private let stepsType = HKQuantityType(.stepCount)

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    /// Workouts, their distance and steps always; routes only when the person wants them uploaded.
    func readTypes(withRoutes: Bool) -> Set<HKObjectType> {
        var s: Set<HKObjectType> = [HKObjectType.workoutType(), stepsType]
        distanceTypes.forEach { s.insert($0) }
        if withRoutes { s.insert(HKSeriesType.workoutRoute()) }
        return s
    }

    /// True when Health would show its permission sheet (some of these have never been asked about).
    /// Health never says whether reading was allowed - only whether the question was asked.
    func needsAsking(withRoutes: Bool) async -> Bool {
        guard isAvailable else { return false }
        return await withCheckedContinuation { cont in
            store.getRequestStatusForAuthorization(toShare: [], read: readTypes(withRoutes: withRoutes)) { status, _ in
                cont.resume(returning: status == .shouldRequest)
            }
        }
    }

    func requestAccess(withRoutes: Bool) async throws {
        try await store.requestAuthorization(toShare: [], read: readTypes(withRoutes: withRoutes))
    }

    /// Workouts that started between [from] and [to] (inclusive, local days), newest first.
    func readWorkouts(from: Day, to: Day, withRoutes: Bool) async throws -> [DeviceWorkout] {
        let start = from.date, end = min(to.adding(days: 1).date, Date())
        guard start < end else { return [] }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let workouts: [HKWorkout] = try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: predicate, limit: 1000,
                                  sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]) { _, results, error in
                if let error { cont.resume(throwing: error) } else { cont.resume(returning: (results as? [HKWorkout]) ?? []) }
            }
            store.execute(q)
        }
        var out: [DeviceWorkout] = []
        for w in workouts {
            let minutes = Int(w.duration / 60)
            guard minutes > 0 else { continue }
            let route: RouteState
            if withRoutes, let pts = try? await routePoints(of: w), pts.count >= 2 { route = .available(pts) } else { route = .none }
            out.append(DeviceWorkout(sourceRef: w.uuid.uuidString, type: w.workoutActivityType.label, start: w.startDate, end: w.endDate, minutes: minutes,
                                     distanceMeters: distanceMeters(of: w), route: route, sourceApp: w.sourceRevision.source.name))
        }
        return out
    }

    /// The workout's own distance statistic for whichever distance type it recorded. Nil, not zero, when nothing was recorded.
    private func distanceMeters(of w: HKWorkout) -> Double? {
        for t in distanceTypes {
            if let m = w.statistics(for: t)?.sumQuantity()?.doubleValue(for: .meter()), m > 0 { return m }
        }
        if let m = w.totalDistance?.doubleValue(for: .meter()), m > 0 { return m }
        return nil
    }

    /// Every GPS point recorded with the workout (a workout can carry its route in several pieces).
    private func routePoints(of w: HKWorkout) async throws -> [RoutePoint] {
        let routes: [HKWorkoutRoute] = try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: HKSeriesType.workoutRoute(), predicate: HKQuery.predicateForObjects(from: w), limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, r, e in
                if let e { cont.resume(throwing: e) } else { cont.resume(returning: (r as? [HKWorkoutRoute]) ?? []) }
            }
            store.execute(q)
        }
        var points: [RoutePoint] = []
        for route in routes {
            let locations: [CLLocation] = try await withCheckedThrowingContinuation { cont in
                var acc: [CLLocation] = []
                var finished = false
                let q = HKWorkoutRouteQuery(route: route) { _, locs, done, error in
                    guard !finished else { return }
                    if let error { finished = true; cont.resume(throwing: error); return }
                    acc.append(contentsOf: locs ?? [])
                    if done { finished = true; cont.resume(returning: acc) }
                }
                store.execute(q)
            }
            points += locations.map { RoutePoint(lat: $0.coordinate.latitude, lon: $0.coordinate.longitude,
                                                 timeMs: Int64($0.timestamp.timeIntervalSince1970 * 1000), altitude: $0.altitude) }
        }
        return points
    }

    /// Each day's step total from [from] to [to] (today included so far). Health merges iPhone and Watch so each step counts once.
    func readDailySteps(from: Day, to: Day) async throws -> [Day: Int] {
        let last = min(to, Day.today)
        guard from <= last else { return [:] }
        let start = from.date, end = last.adding(days: 1).date
        return try await withCheckedThrowingContinuation { cont in
            let q = HKStatisticsCollectionQuery(quantityType: stepsType, quantitySamplePredicate: HKQuery.predicateForSamples(withStart: start, end: end, options: []),
                                                options: .cumulativeSum, anchorDate: start, intervalComponents: DateComponents(day: 1))
            q.initialResultsHandler = { _, results, error in
                if let error { cont.resume(throwing: error); return }
                var out: [Day: Int] = [:]
                results?.enumerateStatistics(from: start, to: end) { s, _ in
                    let n = Int(s.sumQuantity()?.doubleValue(for: .count()) ?? 0)
                    if n > 0 { out[Day(s.startDate)] = n }
                }
                cont.resume(returning: out)
            }
            store.execute(q)
        }
    }
}

/// Activity types offered when logging or reviewing; a workout's own label is added if not listed.
let activityTypes = ["Walking", "Running", "Cycling", "Swimming", "Hiking", "Rowing", "Wheelchair", "Strength training", "Yoga", "HIIT", "Elliptical", "Exercise"]
func unitMeters(_ code: String) -> Double { code == "km" ? 1000 : 1609.344 }

private extension HKWorkoutActivityType {
    var label: String {
        switch self {
        case .walking: "Walking"
        case .running: "Running"
        case .cycling: "Cycling"
        case .swimming: "Swimming"
        case .hiking: "Hiking"
        case .yoga: "Yoga"
        case .traditionalStrengthTraining, .functionalStrengthTraining: "Strength training"
        case .elliptical: "Elliptical"
        case .wheelchairWalkPace, .wheelchairRunPace: "Wheelchair"
        case .rowing: "Rowing"
        case .highIntensityIntervalTraining: "HIIT"
        default: "Exercise"
        }
    }
}
