import { DomainException } from './domain.exception';

export class ValidationException extends DomainException {
	constructor(message: string) {
		super(message, 'VALIDATION_ERROR');
		this.name = 'ValidationException';
	}
}
