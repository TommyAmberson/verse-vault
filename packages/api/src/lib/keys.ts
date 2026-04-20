export interface UserMaterial {
  userId: string;
  materialId: string;
}

export function userMaterialKey(x: UserMaterial): string {
  return `${x.userId}:${x.materialId}`;
}

export function jsonBlob(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}
