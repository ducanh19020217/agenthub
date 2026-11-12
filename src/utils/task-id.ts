export function toTaskId(idOrParam: string): string {
  return idOrParam.includes('~') ? idOrParam.replace('~', '/') : idOrParam;
}

export function toRouteId(taskId: string): string {
  return taskId.replace('/', '~');
}
