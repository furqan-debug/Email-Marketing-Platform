"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailModule = void 0;
const common_1 = require("@nestjs/common");
const bullmq_1 = require("@nestjs/bullmq");
const fake_email_provider_1 = require("./fake-email.provider");
const email_provider_1 = require("./email.provider");
const email_worker_1 = require("./email.worker");
let EmailModule = class EmailModule {
};
exports.EmailModule = EmailModule;
exports.EmailModule = EmailModule = __decorate([
    (0, common_1.Module)({
        imports: [
            bullmq_1.BullModule.registerQueue({
                name: 'email',
            }),
        ],
        providers: [
            {
                provide: email_provider_1.EMAIL_PROVIDER,
                useClass: fake_email_provider_1.FakeEmailProvider,
            },
            email_worker_1.EmailWorker,
        ],
        exports: [bullmq_1.BullModule, email_provider_1.EMAIL_PROVIDER],
    })
], EmailModule);
//# sourceMappingURL=email.module.js.map