import Foundation
import HealthKit

struct HealthRecord: Encodable {
    let teamId: Int
    let challengeId: Int
    let activityType: String
    let minutes: Int
    let activityDate: String
    let sourceRef: String
    let startTime: String
    let endTime: String

    enum CodingKeys: String, CodingKey {
        case teamId = "team_id"
        case challengeId = "challenge_id"
        case activityType = "activity_type"
        case minutes
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

/// Reads only completed workouts (duration, type, start date, a stable id) from Apple Health.
/// No routes, heart rate, calories or other health data are requested or uploaded.
final class HealthKitSync {
    private let store = HKHealthStore()
    private let workoutType = HKObjectType.workoutType()

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    func requestAuthorization() async throws {
        guard isAvailable else { throw HealthKitError.unavailable }
        try await store.requestAuthorization(toShare: [], read: [workoutType])
    }

    /// Reads workouts from the last 30 days and converts each to a whole-minute duration,
    /// matching the server's `/api/health/import` contract.
    func readRecentWorkouts(teamId: Int, challengeId: Int) async throws -> [HealthRecord] {
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
        case .rowing: return "Rowing"
        case .highIntensityIntervalTraining: return "HIIT"
        default: return "Exercise"
        }
    }
}
