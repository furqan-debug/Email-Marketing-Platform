"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var EmailWorker_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailWorker = void 0;
const bullmq_1 = require("@nestjs/bullmq");
const common_1 = require("@nestjs/common");
const email_provider_1 = require("./email.provider");
let EmailWorker = EmailWorker_1 = class EmailWorker extends bullmq_1.WorkerHost {
    emailProvider;
    logger = new common_1.Logger(EmailWorker_1.name);
    constructor(emailProvider) {
        super();
        this.emailProvider = emailProvider;
    }
    async process(job) {
        this.logger.log(`Processing email job ${job.id} for ${job.data.to}`);
        const result = await this.emailProvider.send(job.data);
        this.logger.log(`Job ${job.id} completed with providerId: ${result.providerId}`);
        return result;
    }
};
exports.EmailWorker = EmailWorker;
exports.EmailWorker = EmailWorker = EmailWorker_1 = __decorate([
    (0, bullmq_1.Processor)('email'),
    __param(0, (0, common_1.Inject)(email_provider_1.EMAIL_PROVIDER)),
    __metadata("design:paramtypes", [Object])
], EmailWorker);
//# sourceMappingURL=email.worker.js.map