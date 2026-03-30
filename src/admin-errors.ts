export class InvalidAdminInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAdminInputError';
  }
}
