import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { MoviesController, PublicMoviesController } from './movies.controller';
import { MoviesService, PublicMoviesService } from './movies.service';

@Module({
  imports: [PricingModule],
  controllers: [MoviesController, PublicMoviesController],
  providers: [MoviesService, PublicMoviesService],
  exports: [MoviesService, PublicMoviesService],
})
export class MoviesModule {}
