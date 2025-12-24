import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  async validateUser(email: string, password: string): Promise<any> {
    // Implement user validation logic here
    return { id: 1, email }; // Replace with actual user data
  }

  async createUser(signupDto: any): Promise<any> {
    // Implement user creation logic here
    return { id: 1, ...signupDto }; // Replace with actual user data
  }
}
