/**
 * Nombres de sala. Hoy solo hace falta la sala por usuario: los dos
 * destinatarios de un escaneo (quien escanea y el paciente escaneado) son
 * usuarios concretos. `patientRoom` queda preparada por si más adelante se
 * quiere avisar a todo un equipo con acceso al mismo paciente.
 */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function patientRoom(ownerId: string): string {
  return `patient:${ownerId}`;
}
