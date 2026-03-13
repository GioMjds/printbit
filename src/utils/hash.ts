import argon2 from 'argon2';

export const hashPassword = (plain: string) => 
  argon2.hash(plain, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 });

export const verifyPassword = (hash: string, plain: string) =>
  argon2.verify(hash, plain);