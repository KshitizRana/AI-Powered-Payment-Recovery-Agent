export class AppError extends Error {
    constructor(
        public statusCode: number,
        public message: string,
        public code: string = "INTERNAL_ERROR"
    ) {
        super(message);
    }
}

