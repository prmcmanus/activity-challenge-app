import Foundation
import HealthKit

struct HealthRecord: Encodable {
    /// Nil for an individuals-only challenge; encoded by omitting the key.
    let teamId: Int?
    let challengeId: Int
    let activityType: String
    let minutes: Int
    /// Metres, or nil when the workout recorded no distance (encoded by omitting the key).
    let distanceMeters: Double?
    let activityDate: String
    let sourceRef: String
    let startTime: String
    let endTime: String

    enum CodingKeys: String, CodingKey {
        case teamId = "team_id"
        case challengeId = "challenge_id"
        case activityType = "activity_type"
        case minutes
        case distanceMeters = "distance_m"
        case activityDate = "activity_date"
        case sourceRef = "source_ref"
        case startTime = "start_time"
        case endTime = "end_time"
    }
}

enum HealthKitError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        switch self {
        case .unavailable: return "Health data is not available on this device."
        }
    }
}

/// Reads only completed workouts (duration, distance, type, start date, a stable id) from Apple
/// Health. No routes, heart rate, calories or other health data are requested or uploaded.
final class HealthKitSync {
    private let store = HKHealthStore()
    private let workoutType = HKObjectType.workoutType()
    /// The distance a workout can carry, by kind. Read access is asked for so a workout's own
    /// distance statistic can be read; declining it still syncs workouts, just without distance.
    private let distanceTypes: [HKQuantityType] = [
        HKQuantityType(.distanceWalkingRunning),
        HKQuantityType(.distanceCycling),
        HKQuantityType(.distanceSwimming),
        HKQuantityType(.distanceWheelchair),
        HKQuantityType(.distanceDownhillSnowSports),
    ]

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    func requestAuthorization() async throws {
        guard isAvailable else { throw HealthKitError.unavailable }
        var readTypes: Set<HKObjectType> = [workoutType]
        distanceTypes.forEach { readTypes.insert($0) }
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    /// Reads workouts from the last 30 days and converts each to a whole-minute duration plus
    /// distance in metres where one was recorded, matching the server's `/api/health/import`
    /// contract. A distance challenge skips workouts with no distance (the server counts them).
    func readRecentWorkouts(teamId: Int?, challengeId: Int) async throws -> [HealthRecord] {
        let end = Date()
        let start = Calendar.current.date(byAdding: .day, value: -30, to: end) ?? end
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)

        let samples: [HKWorkout] = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: workoutType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, results, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (results as? [HKWorkout]) ?? [])
            }
            store.execute(query)
        }

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        dateFormatter.timeZone = .current
        let timeFormatter = DateFormatter()
        timeFormatter.dateFormat = "HH:mm"
        timeFormatter.timeZone = .current

        return samples.compactMap { workout in
            let minutes = Int(workout.duration / 60)
            guard minutes > 0 else { return nil }
            return HealthRecord(
                teamId: teamId,
                challengeId: challengeId,
                activityType: workout.workoutActivityType.activeTogetherLabel,
                minutes: minutes,
                distanceMeters: distanceMeters(of: workout),
                activityDate: dateFormatter.string(from: workout.startDate),
                sourceRef: workout.uuid.uuidString,
                // Only meaningful when the workout doesn't cross midnight in the local zone - the
                // server treats an inconsistent pair as "no times" rather than rejecting the sync.
                startTime: timeFormatter.string(from: workout.startDate),
                endTime: timeFormatter.string(from: workout.endDate)
            )
        }
    }
}

extension HealthKitSync {
    /// The workout's own distance statistic for whichever distance type it recorded. Falls back to
    /// `totalDistance` (deprecated from iOS 18 but still populated by older workouts) when no
    /// statistic is available. Nil, not zero, when nothing was recorded.
    fileprivate func distanceMeters(of workout: HKWorkout) -> Double? {
        for type in distanceTypes {
            if let sum = workout.statistics(for: type)?.sumQuantity() {
                let meters = sum.doubleValue(for: .meter())
                if meters > 0 { return meters }
            }
        }
        if let total = workout.totalDistance?.doubleValue(for: .meter()), total > 0 { return total }
        return nil
    }
}

private extension HKWorkoutActivityType {
    /// Short human-readable label; falls back to "Exercise" for types not explicitly named here.
    var activeTogetherLabel: String {
        switch self {
        case .walking: return "Walking"
        case .running: return "Running"
        case .cycling: return "Cycling"
        case .swimming: return "Swimming"
        case .hiking: return "Hiking"
        case .yoga: return "Yoga"
        case .traditionalStrengthTraining, .functionalStrengthTraining: return "Strength training"
        case .elliptical: return "Elliptical"
        case .wheelchairWalkPace, .wheelchairRunPace: return "Wheelchair"
        case .rowing: return "Rowing"
        case .highIntensityIntervalTraining: return "HIIT"
        default: return "Exercise"
        }
    }
}
