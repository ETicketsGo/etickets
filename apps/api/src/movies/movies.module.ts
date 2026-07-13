import { Module } from '@nestjs/common';
import {
  MoviesController,
  PublicMoviesController,
} from './movies.controller';
import { MoviesService, PublicMoviesService } from './movies.service';

@Module({
  controllers: [MoviesController, PublicMoviesController],
  providers: [MoviesService, PublicMoviesService],
  exports: [MoviesService, PublicMoviesService],
})
export class MoviesModule {}
