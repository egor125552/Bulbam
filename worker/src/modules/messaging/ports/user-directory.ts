export interface DirectoryUser {
  userId: string;
  username: string;
  displayName: string;
}

export interface UserDirectory {
  findUser(userId: string): Promise<DirectoryUser | null>;
}
