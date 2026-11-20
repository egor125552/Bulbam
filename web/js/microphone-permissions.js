export function explainMicrophoneError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError" ||
      error?.name === "SecurityError") {
    return "Нет доступа к микрофону. Разрешите его для Бульбама в настройках этого сайта или браузера и попробуйте снова.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "Микрофон не найден. Подключите микрофон или выберите другой источник звука.";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "Микрофон занят или недоступен системе. Завершите другой звонок или выберите другое устройство.";
  }
  if (error?.name === "OverconstrainedError") {
    return "Микрофон не поддерживает выбранное качество. Измените режим микрофона.";
  }
  return error?.message || "Неизвестная ошибка микрофона.";
}
