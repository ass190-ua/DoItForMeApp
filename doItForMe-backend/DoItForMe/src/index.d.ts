import 'dotenv/config';
declare global {
    namespace Express {
        interface Request {
            user?: any;
        }
    }
}
//# sourceMappingURL=index.d.ts.map