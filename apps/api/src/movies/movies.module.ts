import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { MoviesController, PublicMoviesController } from './movies.controller';
import { MoviesService, PublicMoviesService } from './movies.service';
import { MoviePosterService } from './movie-poster.service';

@Module({
  imports: [PricingModule],
  controllers: [MoviesController, PublicMoviesController],
  providers: [MoviesService, PublicMoviesService, MoviePosterService],
  exports: [MoviesService, PublicMoviesService],
})
export class MoviesModule {}
