import { Request } from "express";

export interface ChallengeRequestBody {
    walletAddress: string;
}

export interface ChallengeResponse {
    challenge: string;
    expiresAt: string;
}

export interface ConnectRequestBody {
    walletAddress: string;
    challenge: string;
    signature: string;
}

export interface ConnectResponse {
    token: string;
    user: {
        id: string;
        walletAddress: string;
        createdAt: string;
        lastLoginAt: string;
    };
}

export interface JwtPayload {
    userId: string;
    walletAddress: string;
    role?: string;
    iat?: number;
    exp?: number;
}

export interface AuthenticatedUser {
    userId: string;
    walletAddress: string;
    role?: string;
}

export interface AuthRequest extends Request {
    user?: AuthenticatedUser;
    userId?: string;
}
