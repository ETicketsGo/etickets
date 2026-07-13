import { Injectable } from '@nestjs/common';
import { PublicMoviesService } from '../../movies/movies.service';
import {
  DiscoveryContext,
  DiscoverySection,
  DiscoveryStrategy,
} from './discovery-strategy.interface';

const LIMIT = 10;

/**
 * Newest movie releases. PublicMoviesService.list already orders by
 * releaseDate desc, so we reuse it (optionally scoped to the city) and slice.
 */
@Injectable()
export class NewReleasesStrategy implements DiscoveryStrategy {
  readonly key = 'new-releases';

  constructor(private readonly publicMovies: PublicMoviesService) {}

  async discover(ctx: DiscoveryContext): Promise<DiscoverySection> {
    const movies = await this.publicMovies.list({ city: ctx.city });
    return {
      key: this.key,
      title: 'New releases',
      kind: 'movies',
      items: movies.slice(0, LIMIT),
    };
  }
}
