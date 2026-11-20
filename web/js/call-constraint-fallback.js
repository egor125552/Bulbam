// Some mobile browsers reject multi-key live constraints even though they
// accept individual processing controls. Never discard a working audio track.
export async function applyCallConstraintsBestEffort(track, constraints, trace = () => {}) {
  if (typeof track?.applyConstraints !== "function") { trace('изменение ограничений недоступно'); return { applied: false, reduced: true }; }
  trace('полные ограничения начало');
  try {
    await track.applyConstraints(constraints);
    trace('полные ограничения успешно');
    return { applied: true, reduced: false };
  } catch (fullError) {
    trace('полные ограничения ошибка', safeConstraintFailure(fullError));
    const processing = Object.fromEntries(
      ["echoCancellation", "noiseSuppression", "autoGainControl"]
        .filter((key) => typeof constraints[key] === "boolean")
        .map((key) => [key, constraints[key]])
    );
    if (!Object.keys(processing).length) throw fullError;
    trace('обработка звука начало');
    try {
      await track.applyConstraints(processing);
      trace('обработка звука успешно');
      return { applied: true, reduced: true };
    } catch (combinedError) {
      trace('обработка звука ошибка',safeConstraintFailure(combinedError));
      // Best effort must be honest: report success only when the browser
      // accepted at least one requested switch. Unsupported keys remain as-is.
      let accepted = 0;
      for (const [key, value] of Object.entries(processing)) {
        trace(`${key} начало`);
        try {
          await track.applyConstraints({ [key]: value });
          accepted += 1;
          trace(`${key} успешно`);
        } catch (error) {
          trace(`${key} ошибка`,safeConstraintFailure(error));
          // Hardware/OS may lock a processing mode during active capture.
        }
      }
      if (accepted > 0) return { applied: true, reduced: true };
      throw combinedError;
    }
  }
}

const SAFE_FAILURE_NAMES=new Set(['Error','TypeError','NotReadableError','NotAllowedError','OverconstrainedError','InvalidStateError','OperationError','NotSupportedError','InvalidModificationError','AbortError']);
function safeConstraintFailure(error){ return SAFE_FAILURE_NAMES.has(error?.name)?error.name:'OtherError'; }
