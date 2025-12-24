import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { UserService } from '../user/user.service'; // Adjusted the path
import { AuthResponse } from 'src/components/members/member.resolver';

// Define LoginDto and SignupDto if not already defined elsewhere
interface LoginDto {
  email: string;
  password: string;
}

interface SignupDto {
  email: string;
  password: string;
  name: string;
}

@Injectable()
export class AuthService {
  private readonly userService: UserService;

  constructor(userService: UserService) {
    this.userService = userService;
  }

  async login(credentials: LoginDto): Promise<AuthResponse> {
    // Disable SSO logic
    // if (this.isSSOEnabled) {
    //     return this.ssoLogin(credentials);
    // }

    // Re-enable traditional login logic
    const user = await this.userService.validateUser(
      credentials.email,
      credentials.password,
    );
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.generateToken(user);
  }

  async signup(signupDto: SignupDto): Promise<AuthResponse> {
    // Disable SSO logic
    // if (this.isSSOEnabled) {
    //     throw new BadRequestException('Signup is not allowed with SSO enabled');
    // }

    // Re-enable traditional signup logic
    const user = await this.userService.createUser(signupDto);
    return this.generateToken(user);
  }

  private generateToken(user: any): AuthResponse {
    // Implement token generation logic here
    return {
      token: 'generated-token', // Replace with actual token logic
      user,
    };
  }
}
